'use strict';

// Quota forecast controller (tech spec §26.3, §23, §24).
//
// Owns the forecast lifecycle in the desktop widget:
//   observe latestStats
//     -> extract forecastable windows
//     -> dedupe + append snapshots
//     -> prune + persist
//     -> calculate forecasts
//     -> apply hysteresis
//     -> aggregate global risk
//     -> emit state (tray + renderer)
//
// The controller is a consumer of the existing limits abstraction: it never
// polls providers, never changes the refresh cadence, and never touches the hub
// protocol. In sync/host mode it sees the same hub-aggregated `stats.limits`
// the renderer gets — quota is account state, not per-device counters (§33.7).
//
// Every failure is fail-open: history read/write errors and forecast errors
// degrade to `forecast unavailable` (§5.2), never a crash.

const {
  aggregateQuotaRisk,
  calculateQuotaForecasts,
  extractQuotaSnapshots,
  forecastStaleAfterMs,
  sameObservation,
  snapshotSeriesKey
} = require('../shared/quotaForecast');

const DEFAULT_CRITICAL_ETA_MINUTES = 60;
const DEFAULT_BURST_WARNING_ETA_MINUTES = 30;
const DEFAULT_HISTORY_RETENTION_DAYS = 14;
// Re-evaluate periodically so a stale CRITICAL cannot pin the tray red while
// the widget is simply not receiving new stats (§28, §33.6).
const STALENESS_REEVALUATION_MS = 30 * 1000;
const RISK_RANK = { critical: 3, warning: 2, safe: 1, unknown: 0 };

function createQuotaForecastController(options = {}) {
  const store = options.store || null;
  const getSettings = options.getSettings || (() => ({}));
  const logger = options.logger || (() => {});
  const nowMs = () => (typeof options.nowMs === 'function' ? options.nowMs() : Date.now());
  const emit = options.emit || (() => {});
  const recheckIntervalMs = Number.isFinite(options.recheckIntervalMs)
    ? options.recheckIntervalMs
    : STALENESS_REEVALUATION_MS;

  let history = [];
  let lastObservation = new Map();
  let lastResetsAt = new Map();
  let lastRisk = new Map();
  let downgradeCounts = new Map();
  let lastStatsLimits = null;
  let state = {
    enabled: true,
    globalRisk: { risk: 'unknown', trigger: null },
    forecasts: [],
    updatedAt: null
  };
  let stalenessTimer = null;

  function safeLog(message) {
    try { logger(`[quota-forecast] ${message}`); } catch (_) {}
  }

  function settingsSnapshot() {
    return getSettings() || {};
  }

  function alertsEnabled() {
    return settingsSnapshot().predictiveQuotaAlertsEnabled !== false;
  }

  function criticalEtaMs() {
    const minutes = Number(settingsSnapshot().predictiveQuotaCriticalEtaMinutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : DEFAULT_CRITICAL_ETA_MINUTES * 60 * 1000;
  }

  function staleAfterMs() {
    return forecastStaleAfterMs(lastStatsLimits, {
      defaultRefreshMs: 5 * 60 * 1000
    });
  }

  // Load persisted history and resume trend tracking (§10.1, §33.4).
  // Fail-open: a read error starts with empty history, never a crash (§5.2).
  async function start() {
    let loaded = { snapshots: [] };
    try {
      loaded = store ? store.read() : { snapshots: [] };
    } catch (error) {
      safeLog(`history load failed: ${error.message}`);
    }
    history = store && typeof store.prune === 'function' ? store.prune(loaded.snapshots) : loaded.snapshots;
    for (const snapshot of history) {
      lastObservation.set(snapshotSeriesKey(snapshot), snapshot);
      lastResetsAt.set(snapshotSeriesKey(snapshot), snapshot.resetsAt);
    }
    scheduleStalenessReevaluation();
    recompute();
    return history.length;
  }

  function stop() {
    if (stalenessTimer) {
      clearInterval(stalenessTimer);
      stalenessTimer = null;
    }
  }

  function scheduleStalenessReevaluation() {
    if (stalenessTimer || recheckIntervalMs <= 0) return;
    stalenessTimer = setInterval(() => {
      try { recompute(); } catch (error) { safeLog(`recompute failed: ${error.message}`); }
    }, recheckIntervalMs);
    if (typeof stalenessTimer.unref === 'function') stalenessTimer.unref();
  }

  function getState() {
    return state;
  }

  // Authoritative limits update from the widget's normal stats flow. This is
  // the ONLY place snapshots are recorded (§9).
  async function update(stats) {
    if (!stats || typeof stats !== 'object') return;
    lastStatsLimits = stats.limits || null;
    const observedAt = nowMs();
    let snapshots;
    try {
      snapshots = extractQuotaSnapshots(stats, { observedAt });
    } catch (error) {
      safeLog(`extract failed: ${error.message}`);
      recompute();
      return;
    }
    const fresh = [];
    for (const snapshot of snapshots) {
      const key = snapshotSeriesKey(snapshot);
      const previous = lastObservation.get(key);
      if (previous && sameObservation(previous, snapshot)) continue;
      lastObservation.set(key, snapshot);
      if (!snapshot.persistable) continue;
      fresh.push(snapshot);
    }
    if (fresh.length > 0) {
      history = history.concat(fresh);
      if (store && typeof store.prune === 'function') history = store.prune(history);
      // Recompute synchronously so the tray and renderer see the new risk on
      // this same stats push; persistence is fire-and-forget.
      recompute();
      if (store) await store.write(history).catch(() => false);
      return;
    }
    recompute();
  }

  // Recompute forecasts and the global risk from the in-memory history.
  function recompute() {
    let forecasts;
    try {
      forecasts = calculateQuotaForecasts(history, {
        nowMs: nowMs(),
        criticalEtaMs: criticalEtaMs(),
        burstWarningEtaMs: DEFAULT_BURST_WARNING_ETA_MINUTES * 60 * 1000,
        staleAfterMs: staleAfterMs()
      });
    } catch (error) {
      safeLog(`forecast calculation failed: ${error.message}`);
      state = {
        ...state,
        enabled: alertsEnabled(),
        globalRisk: { risk: 'unknown', trigger: null },
        forecasts: [],
        updatedAt: new Date(nowMs()).toISOString()
      };
      emit(state);
      return;
    }
    const applied = forecasts.map((forecast) => applyHysteresis(forecast));
    const globalRisk = aggregateQuotaRisk(applied);
    state = {
      enabled: alertsEnabled(),
      globalRisk,
      forecasts: applied,
      updatedAt: new Date(nowMs()).toISOString()
    };
    emit(state);
  }

  // Hysteresis (§16): upgrades are immediate; downgrades need two consecutive
  // authoritative snapshots at the safer level. A reset generation change
  // re-evaluates immediately.
  function applyHysteresis(forecast) {
    const key = forecast.seriesKey;
    const previousRisk = lastRisk.get(key);
    const previousResetsAt = lastResetsAt.get(key);
    const generationChanged = previousResetsAt !== undefined && previousResetsAt !== forecast.resetsAt;
    lastResetsAt.set(key, forecast.resetsAt);
    // 'unknown' (insufficient data, stale) is not a safer state — holding it
    // would keep a stale CRITICAL pinning the tray red (§28). Always immediate.
    if (forecast.risk === 'unknown' || previousRisk === undefined || previousRisk === forecast.risk || generationChanged) {
      if (generationChanged || forecast.risk === 'unknown') downgradeCounts.delete(key);
      lastRisk.set(key, forecast.risk);
      return forecast;
    }
    const upgrading = RISK_RANK[forecast.risk] > RISK_RANK[previousRisk];
    if (upgrading) {
      downgradeCounts.delete(key);
      lastRisk.set(key, forecast.risk);
      return forecast;
    }
    // Downgrade: require N consecutive snapshots at the safer level.
    const pending = downgradeCounts.get(key) || { risk: forecast.risk, count: 0 };
    if (pending.risk !== forecast.risk) {
      downgradeCounts.set(key, { risk: forecast.risk, count: 1 });
    } else {
      pending.count += 1;
      downgradeCounts.set(key, pending);
    }
    if (pending.count >= hysteresisSnapshots()) {
      downgradeCounts.delete(key);
      lastRisk.set(key, forecast.risk);
      return forecast;
    }
    return {
      ...forecast,
      risk: previousRisk,
      hysteresisPending: true
    };
  }

  function hysteresisSnapshots() {
    const value = Number(settingsSnapshot().predictiveQuotaHysteresisSnapshots);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 2;
  }

  return {
    getState,
    recheck: recompute,
    start,
    stop,
    update
  };
}

module.exports = {
  DEFAULT_BURST_WARNING_ETA_MINUTES,
  DEFAULT_CRITICAL_ETA_MINUTES,
  DEFAULT_HISTORY_RETENTION_DAYS,
  createQuotaForecastController
};
