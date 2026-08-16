'use strict';

// Predictive Quota Alert — pure forecast engine.
//
// Consumer of the existing normalized limits abstraction (`stats.limits` from
// src/shared/limits.js). It never talks to providers, never polls, and never
// touches the hub protocol. All persistence lives in the electron layer; this
// module is deliberately free of fs / Electron / IPC / network / credentials so
// it stays unit-testable with node:test.
//
// The question this answers is not "how much quota is left" but "at the current
// burn rate, will the quota run out before it resets?".
//
//   burnRate (percentage points / hour) -> estimatedExhaustionAt
//   compare with resetsAt -> SAFE / WARNING / CRITICAL
//
// Reference design: tech spec v1 (Predictive Quota Alert), §6–§17.

const { hashKey } = require('./hashKey');
const { staleAfterMsForSyncUpload } = require('./syncUploadInterval');

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Data quality gate (§12.3): a rate needs at least these samples and span.
const MIN_RATE_SAMPLE_COUNT = 3;
const MIN_RATE_SPAN_MS = 10 * MINUTE_MS;

// Windows that cannot be time-predicted (prepaid balances, spend) must never
// get a fabricated ETA (§6.1, §6.2).
const UNPREDICTABLE_METRICS = new Set(['credits', 'spend']);

// A usedPercent drop of this size while resetsAt is unchanged is treated as a
// provider quota correction / reset that is not a negative burn (§11.2).
const LOCAL_SEGMENT_DROP_PP = 5;

const RISK_RANK = { critical: 3, warning: 2, safe: 1, unknown: 0 };

const SESSION_LOOKBACKS = ['1h', '30m', '15m'];
const WEEKLY_LOOKBACKS = ['24h', '12h', '6h', '3h', '2h', '1h'];

const LOOKBACK_MS = {
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': HOUR_MS,
  '2h': 2 * HOUR_MS,
  '3h': 3 * HOUR_MS,
  '6h': 6 * HOUR_MS,
  '12h': 12 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS
};

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

// OLS slope of y over x. Returns null when there are fewer than two points or
// the x variance is zero (all samples share one timestamp).
function olsSlope(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sx += point.x;
    sy += point.y;
    sxx += point.x * point.x;
    sxy += point.x * point.y;
  }
  const denominator = n * sxx - sx * sx;
  if (denominator === 0) return null;
  return (n * sxy - sx * sy) / denominator;
}

// Stable account identity: prefer the provider's own accountKey, else a hash of
// the stable non-email identity fields. Email is deliberately never used as a
// persistence key (§7.1, §37). Returns null when no stable identity exists; such
// a series may still be used for the process lifetime but must not be persisted.
function stableAccountIdentity(provider) {
  const key = String(provider?.accountKey || '').trim();
  if (key) return key;
  const parts = [
    String(provider?.accountName || '').trim(),
    String(provider?.accountLabel || '').trim(),
    String(provider?.planLabel || '').trim()
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return hashKey(String(provider?.provider || ''), 'identity', ...parts);
}

// Series key: provider + account identity + window kind + normalized label +
// metric. `resetsAt` is deliberately NOT part of the key — it is a generation
// boundary within one series (§7.1, §7.2).
function seriesKey(provider, accountKey, window) {
  const parts = [
    String(provider?.provider || '').trim().toLowerCase(),
    String(accountKey || ''),
    String(window?.kind || '').trim().toLowerCase(),
    String(window?.label || '').trim(),
    String(window?.metric || '').trim().toLowerCase()
  ];
  return parts.join(':');
}

// A window is forecastable when it carries a percentage and a reset time and is
// not a pure balance/spend metric (§6.1).
function isForecastableWindow(window) {
  if (!window || typeof window !== 'object') return false;
  const metric = String(window.metric || '').trim().toLowerCase();
  if (UNPREDICTABLE_METRICS.has(metric)) return false;
  if (!Number.isFinite(window.usedPercent)) return false;
  if (!Number.isFinite(window.remainingPercent)) return false;
  return parseIsoMs(window.resetsAt) !== null;
}

// Extract forecastable snapshots from an authoritative normalized limits update
// (the same shape `stats.limits` carries in every mode: local, sync, host).
// Only providers with status "ok" contribute (§6.1).
function extractQuotaSnapshots(stats, options = {}) {
  const observedAt = Number.isFinite(options.observedAt) ? options.observedAt : Date.now();
  const limits = stats?.limits && typeof stats.limits === 'object' ? stats.limits : stats || {};
  const providers = Array.isArray(limits.providers) ? limits.providers : [];
  const limitsUpdatedAt = limits.updatedAt || null;
  const snapshots = [];
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    if (String(provider.status || '').trim() !== 'ok') continue;
    const accountKey = stableAccountIdentity(provider);
    const sourceUpdatedAt = String(provider.updatedAt || limitsUpdatedAt || '') || null;
    const windows = Array.isArray(provider.windows) ? provider.windows : [];
    for (const window of windows) {
      if (!isForecastableWindow(window)) continue;
      snapshots.push({
        observedAt: new Date(observedAt).toISOString(),
        sourceUpdatedAt,
        provider: String(provider.provider || '').trim().toLowerCase(),
        accountKey: accountKey || '',
        persistable: accountKey !== null,
        windowKind: String(window.kind || '').trim().toLowerCase(),
        windowLabel: String(window.label || '').trim(),
        metric: String(window.metric || '').trim().toLowerCase() || null,
        usedPercent: window.usedPercent,
        remainingPercent: window.remainingPercent,
        resetsAt: new Date(parseIsoMs(window.resetsAt)).toISOString()
      });
    }
  }
  return snapshots;
}

function sameObservation(previous, next) {
  return previous.sourceUpdatedAt === next.sourceUpdatedAt
    && previous.usedPercent === next.usedPercent
    && previous.remainingPercent === next.remainingPercent
    && previous.resetsAt === next.resetsAt;
}

// Deduplicate identical consecutive observations per series (§9.1). A renderer
// refresh, SSE replay, or tray redraw is not a new provider observation.
function dedupeSnapshots(snapshots) {
  const seen = new Map();
  const result = [];
  for (const snapshot of snapshots) {
    const key = snapshot.seriesKey || snapshotSeriesKey(snapshot);
    const previous = seen.get(key);
    if (previous && sameObservation(previous, snapshot)) continue;
    seen.set(key, snapshot);
    result.push(snapshot);
  }
  return result;
}

// Split one series' snapshots (sorted ascending by observedAt) into segments.
// A new segment starts when resetsAt changes (generation boundary, §11.1) or
// when usedPercent drops by >= 5pp with an unchanged resetsAt (provider quota
// correction, §11.2). Rates never cross a segment boundary.
function segmentSnapshots(snapshots) {
  const segments = [];
  for (const snapshot of snapshots) {
    const current = segments[segments.length - 1];
    const previous = current ? current.samples[current.samples.length - 1] : null;
    const generationChanged = !previous || previous.resetsAt !== snapshot.resetsAt;
    const corrected = previous
      && previous.resetsAt === snapshot.resetsAt
      && previous.usedPercent - snapshot.usedPercent >= LOCAL_SEGMENT_DROP_PP;
    if (!current || generationChanged || corrected) {
      segments.push({ resetsAt: snapshot.resetsAt, samples: [snapshot] });
    } else {
      current.samples.push(snapshot);
    }
  }
  return segments;
}

// A lookback's rate is only meaningful when the data actually covers a
// meaningful fraction of that lookback. With one hour of history, a "24h" rate
// would silently pretend a short burst is a day-long trend (§12.5).
const LOOKBACK_SPAN_RATIO = 0.6;

// Regression over the samples within `lookbackMs` of now, in the active
// segment. Returns { rate, sampleCount, sampleSpanMs } or null when the data
// quality gate (§12.3) fails. A rate <= 0 is returned as-is: it means "no
// current burn" and is handled by the caller, never treated as a negative ETA.
function lookbackRate(samples, lookbackMs, nowMs) {
  const within = samples.filter((sample) => {
    const at = parseIsoMs(sample.observedAt);
    return at !== null && at >= nowMs - lookbackMs && at <= nowMs + MINUTE_MS;
  });
  const count = within.length;
  if (count < MIN_RATE_SAMPLE_COUNT) return null;
  const first = parseIsoMs(within[0].observedAt);
  const last = parseIsoMs(within[count - 1].observedAt);
  const spanMs = last - first;
  if (spanMs < MIN_RATE_SPAN_MS) return null;
  if (spanMs < lookbackMs * LOOKBACK_SPAN_RATIO) return null;
  const points = within.map((sample) => ({
    x: (parseIsoMs(sample.observedAt) - first) / HOUR_MS,
    y: sample.usedPercent
  }));
  const slope = olsSlope(points);
  if (slope === null) return null;
  return { rate: slope, sampleCount: count, sampleSpanMs: spanMs };
}

// Pick the best available rate for a window kind. Session's primary is 1h with
// longest-valid-<=1h fallback (§12.4); weekly's primary is 24h with 1h fallback
// (§12.5). Returns { rate, lookback, sampleCount, sampleSpanMs } | null.
function primaryRateFor(windowKind, samples, nowMs) {
  const candidates = windowKind === 'weekly'
    ? WEEKLY_LOOKBACKS
    : SESSION_LOOKBACKS;
  for (const lookback of candidates) {
    const rate = lookbackRate(samples, LOOKBACK_MS[lookback], nowMs);
    if (rate) return { ...rate, lookback };
  }
  return null;
}

// Secondary/burst rate: session uses 15m, weekly uses 1h. Never duplicates the
// primary lookback (§12.4, §12.5).
function secondaryRateFor(windowKind, samples, nowMs, options = {}) {
  if (windowKind === 'weekly') {
    if (options.lookback === '1h') return null;
    const rate = lookbackRate(samples, LOOKBACK_MS['1h'], nowMs);
    if (rate) return { ...rate, lookback: '1h' };
    return null;
  }
  if (options.lookback === '15m') return null;
  const rate = lookbackRate(samples, LOOKBACK_MS['15m'], nowMs);
  if (rate) return { ...rate, lookback: '15m' };
  return null;
}

function confidenceFor(windowKind, primary, _secondary) {
  if (!primary) return 'insufficient';
  const spanMs = primary.sampleSpanMs;
  const count = primary.sampleCount;
  if (windowKind === 'weekly') {
    if (primary.lookback === '24h' && spanMs >= 18 * HOUR_MS && count >= 6) return 'high';
    if (primary.lookback === '1h') return 'low';
    return 'medium';
  }
  if (primary.lookback === '1h' && spanMs >= 45 * MINUTE_MS && count >= 6) return 'high';
  if (primary.lookback !== '1h') return 'low';
  return 'medium';
}

function exhaustionFromRate(latest, rate) {
  if (!rate || rate.rate <= 0) return { exhaustionMs: null };
  const remainingPp = Math.max(0, 100 - latest.usedPercent);
  const hoursToExhaustion = remainingPp / rate.rate;
  return { exhaustionMs: parseIsoMs(latest.observedAt) + hoursToExhaustion * HOUR_MS };
}

// Risk evaluation (§15) plus burst escalation (§15.5). The controller applies
// hysteresis on top of this per-series result; this function is stateless.
function evaluateRisk({
  latest,
  primary,
  secondary,
  nowMs,
  criticalEtaMs,
  burstWarningEtaMs
}) {
  const resetsAtMs = parseIsoMs(latest.resetsAt);
  const timeToResetMs = resetsAtMs - nowMs;

  // Direct critical (§15.4): burn rate may not be stable yet, but the quota is
  // nearly gone and the reset is far enough away that nothing will save it.
  if (latest.remainingPercent <= 5 && timeToResetMs > 15 * MINUTE_MS) {
    return {
      risk: 'critical',
      reason: 'nearly-empty',
      estimatedExhaustionAt: null,
      timeToExhaustionMs: null,
      exhaustionBeforeResetMs: null
    };
  }

  if (!primary) {
    return {
      risk: 'unknown',
      reason: 'insufficient-data',
      estimatedExhaustionAt: null,
      timeToExhaustionMs: null,
      exhaustionBeforeResetMs: null
    };
  }

  const { exhaustionMs } = exhaustionFromRate(latest, primary);
  if (exhaustionMs === null) {
    // No current burn (§12.3): never a warning, never an ETA.
    return {
      risk: 'safe',
      reason: 'no-burn',
      estimatedExhaustionAt: null,
      timeToExhaustionMs: null,
      exhaustionBeforeResetMs: null
    };
  }

  const estimatedExhaustionAt = new Date(exhaustionMs).toISOString();
  const timeToExhaustionMs = exhaustionMs - nowMs;
  const exhaustionBeforeResetMs = resetsAtMs - exhaustionMs;
  const exhaustsBeforeReset = exhaustionBeforeResetMs > 0;

  // Burst escalation (§15.5): session window, primary 1h still safe, but the
  // 15m rate says we run out well before reset — escalate to WARNING only.
  if (!exhaustsBeforeReset && latest.windowKind === 'session' && secondary) {
    const burst = exhaustionFromRate(latest, secondary);
    if (burst.exhaustionMs !== null) {
      const burstBeforeReset = resetsAtMs - burst.exhaustionMs;
      const burstTimeToExhaustion = burst.exhaustionMs - nowMs;
      if (burstBeforeReset > 0 && burstTimeToExhaustion <= burstWarningEtaMs) {
        return {
          risk: 'warning',
          reason: 'burst',
          estimatedExhaustionAt: new Date(burst.exhaustionMs).toISOString(),
          timeToExhaustionMs: burstTimeToExhaustion,
          exhaustionBeforeResetMs: burstBeforeReset
        };
      }
    }
  }

  if (!exhaustsBeforeReset) {
    return {
      risk: 'safe',
      reason: 'survives-reset',
      estimatedExhaustionAt,
      timeToExhaustionMs,
      exhaustionBeforeResetMs
    };
  }

  if (timeToExhaustionMs <= criticalEtaMs) {
    return {
      risk: 'critical',
      reason: 'eta-critical',
      estimatedExhaustionAt,
      timeToExhaustionMs,
      exhaustionBeforeResetMs
    };
  }

  return {
    risk: 'warning',
    reason: 'exhausts-before-reset',
    estimatedExhaustionAt,
    timeToExhaustionMs,
    exhaustionBeforeResetMs
  };
}

// Full pipeline for one series: segmentation -> rates -> ETA -> risk.
function forecastSeries(seriesKey, snapshots, options) {
  const ordered = [...snapshots].sort((a, b) => parseIsoMs(a.observedAt) - parseIsoMs(b.observedAt));
  const latest = ordered[ordered.length - 1];
  const segments = segmentSnapshots(ordered);
  const active = segments[segments.length - 1];
  const samples = active.samples;
  const nowMs = options.nowMs;
  const resetsAtMs = parseIsoMs(latest.resetsAt);
  if (resetsAtMs === null) {
    return {
      seriesKey,
      provider: latest.provider,
      accountKey: latest.accountKey,
      windowKind: latest.windowKind,
      windowLabel: latest.windowLabel,
      usedPercent: latest.usedPercent,
      remainingPercent: latest.remainingPercent,
      resetsAt: latest.resetsAt,
      rate15m: null,
      rate1h: null,
      rate24h: null,
      rate7d: null,
      primaryRate: null,
      primaryLookback: null,
      estimatedExhaustionAt: null,
      timeToExhaustionMs: null,
      timeToResetMs: null,
      exhaustionBeforeResetMs: null,
      confidence: 'insufficient',
      risk: 'unknown',
      riskReason: 'unsupported',
      sampleCount: samples.length,
      sampleSpanMs: observedAtMs - parseIsoMs(samples[0].observedAt)
    };
  }
  const timeToResetMs = resetsAtMs - nowMs;
  const observedAtMs = parseIsoMs(latest.observedAt);

  // Stale data (§28): never let a stale CRITICAL pin the tray red.
  if (nowMs - observedAtMs > options.staleAfterMs) {
    return {
      seriesKey,
      provider: latest.provider,
      accountKey: latest.accountKey,
      windowKind: latest.windowKind,
      windowLabel: latest.windowLabel,
      usedPercent: latest.usedPercent,
      remainingPercent: latest.remainingPercent,
      resetsAt: latest.resetsAt,
      rate15m: null,
      rate1h: null,
      rate24h: null,
      rate7d: null,
      primaryRate: null,
      primaryLookback: null,
      estimatedExhaustionAt: null,
      timeToExhaustionMs: null,
      timeToResetMs,
      exhaustionBeforeResetMs: null,
      confidence: 'insufficient',
      risk: 'unknown',
      riskReason: 'stale',
      sampleCount: samples.length,
      sampleSpanMs: observedAtMs - parseIsoMs(samples[0].observedAt),
      lastForecastAgeMs: nowMs - observedAtMs
    };
  }

  const primary = primaryRateFor(latest.windowKind, samples, nowMs);
  const secondary = secondaryRateFor(latest.windowKind, samples, nowMs, primary || {});
  const rate15m = lookbackRate(samples, LOOKBACK_MS['15m'], nowMs);
  const rate1h = lookbackRate(samples, LOOKBACK_MS['1h'], nowMs);
  const rate24h = lookbackRate(samples, LOOKBACK_MS['24h'], nowMs);
  const rate7d = lookbackRate(samples, LOOKBACK_MS['7d'], nowMs);

  const risk = evaluateRisk({
    latest,
    primary,
    secondary,
    nowMs,
    criticalEtaMs: options.criticalEtaMs,
    burstWarningEtaMs: options.burstWarningEtaMs
  });

  return {
    seriesKey,
    provider: latest.provider,
    accountKey: latest.accountKey,
    windowKind: latest.windowKind,
    windowLabel: latest.windowLabel,
    usedPercent: latest.usedPercent,
    remainingPercent: latest.remainingPercent,
    resetsAt: latest.resetsAt,
    rate15m: rate15m ? rate15m.rate : null,
    rate1h: rate1h ? rate1h.rate : null,
    rate24h: rate24h ? rate24h.rate : null,
    rate7d: rate7d ? rate7d.rate : null,
    primaryRate: primary ? primary.rate : null,
    primaryLookback: primary ? primary.lookback : null,
    estimatedExhaustionAt: risk.estimatedExhaustionAt,
    timeToExhaustionMs: risk.timeToExhaustionMs,
    timeToResetMs,
    exhaustionBeforeResetMs: risk.exhaustionBeforeResetMs,
    confidence: confidenceFor(latest.windowKind, primary, secondary),
    risk: risk.risk,
    riskReason: risk.reason,
    sampleCount: samples.length,
    sampleSpanMs: observedAtMs - parseIsoMs(samples[0].observedAt)
  };
}

// Series key derived from a snapshot's own identity fields (§7.1). The persisted
// snapshot shape (§8) deliberately has no seriesKey; it is always derived.
function snapshotSeriesKey(snapshot) {
  return [
    String(snapshot.provider || '').trim().toLowerCase(),
    String(snapshot.accountKey || ''),
    String(snapshot.windowKind || '').trim().toLowerCase(),
    String(snapshot.windowLabel || '').trim(),
    String(snapshot.metric || '').trim().toLowerCase()
  ].join(':');
}

// Calculate one QuotaForecast per series. `history` may be a flat snapshot
// array (seriesKey derived from each snapshot's identity fields) or a
// { [seriesKey]: snapshot[] } index.
// options: nowMs, criticalEtaMs (default 60m), burstWarningEtaMs (default 30m),
// staleAfterMs (default 20m).
function calculateQuotaForecasts(history, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const criticalEtaMs = Number.isFinite(options.criticalEtaMs) ? options.criticalEtaMs : 60 * MINUTE_MS;
  const burstWarningEtaMs = Number.isFinite(options.burstWarningEtaMs) ? options.burstWarningEtaMs : 30 * MINUTE_MS;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : 20 * MINUTE_MS;
  const groups = new Map();
  for (const snapshot of history || []) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    const key = snapshot.seriesKey || snapshotSeriesKey(snapshot);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(snapshot);
  }
  const forecasts = [];
  for (const [key, snapshots] of groups) {
    forecasts.push(forecastSeries(key, snapshots, {
      nowMs,
      criticalEtaMs,
      burstWarningEtaMs,
      staleAfterMs
    }));
  }
  forecasts.sort((a, b) => b.timeToResetMs - a.timeToResetMs);
  return forecasts;
}

// Global tray risk: max over all forecasts, with billing windows excluded by
// default (§6.1, §17). `unknown` ranks below `safe` so an unknown series never
// masks an existing safe state.
function aggregateQuotaRisk(forecasts, options = {}) {
  const includeBilling = options.includeBilling === true;
  let best = null;
  let trigger = null;
  for (const forecast of forecasts || []) {
    if (!includeBilling && forecast.windowKind === 'billing') continue;
    const rank = RISK_RANK[forecast.risk] ?? 0;
    if (!best || rank > best.rank || (rank === best.rank && tieBreakWorse(forecast, trigger))) {
      best = { rank, risk: forecast.risk };
      trigger = forecast;
    }
  }
  return { risk: best ? best.risk : 'unknown', trigger };
}

// Tie-break: among equal-risk forecasts, prefer the one whose trigger is more
// imminent — exhausted sooner (or with less margin) is the more useful alert.
function tieBreakWorse(candidate, current) {
  if (!current) return true;
  const candidateExhaustion = parseIsoMs(candidate.estimatedExhaustionAt);
  const currentExhaustion = parseIsoMs(current.estimatedExhaustionAt);
  if (candidateExhaustion !== null && currentExhaustion !== null && candidateExhaustion !== currentExhaustion) {
    return candidateExhaustion < currentExhaustion;
  }
  const candidateMargin = candidate.exhaustionBeforeResetMs;
  const currentMargin = current.exhaustionBeforeResetMs;
  if (candidateMargin !== null && currentMargin !== null && candidateMargin !== currentMargin) {
    return candidateMargin < currentMargin;
  }
  return candidate.timeToResetMs < current.timeToResetMs;
}

// Stale threshold for the consumer: max(2 * refreshMs, sync stale threshold) —
// mirrors limits.isProviderStale() semantics without importing it (§28).
function forecastStaleAfterMs(limits, options = {}) {
  const refreshMs = Number.isFinite(limits?.refreshMs) ? limits.refreshMs : options.defaultRefreshMs || 5 * MINUTE_MS;
  const syncThreshold = staleAfterMsForSyncUpload(
    options.syncUploadIntervalMs,
    options.syncStaleAfterMs || 0
  );
  return Math.max(2 * refreshMs, syncThreshold);
}

module.exports = {
  MIN_RATE_SAMPLE_COUNT,
  MIN_RATE_SPAN_MS,
  aggregateQuotaRisk,
  calculateQuotaForecasts,
  dedupeSnapshots,
  extractQuotaSnapshots,
  forecastStaleAfterMs,
  segmentSnapshots,
  seriesKey,
  snapshotSeriesKey,
  stableAccountIdentity,
  sameObservation
};
