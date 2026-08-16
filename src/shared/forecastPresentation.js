'use strict';

// Presentation helpers for predictive quota alerts (tech spec §20, §21).
//
// Pure formatting: burn rates in pp/hour, durations, ETA clock times, risk
// labels and the tray tooltip line. Shared by the tray (main process), the
// limits view and the settings page (renderer) so every surface reads the
// same way. No fs, no IPC, no network.

(function exposeForecastPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorForecastPresentation = api;
})(typeof window !== 'undefined' ? window : globalThis, function createForecastPresentationApi() {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  const RISK_LABELS = {
    critical: 'CRITICAL',
    warning: 'WARNING',
    safe: 'SAFE',
    unknown: 'UNKNOWN'
  };

  // Explicit yellow / red so the tray badge never depends on subtle color
  // differences (§19). Warning amber, critical red.
  const RISK_BADGE_COLORS = {
    warning: '#f5a623',
    critical: '#e5484d'
  };

  const RISK_LABEL_KEYS = {
    critical: 'limits.forecast.riskCritical',
    warning: 'limits.forecast.riskWarning',
    safe: 'limits.forecast.riskSafe',
    unknown: 'limits.forecast.riskUnknown'
  };

  function riskLabel(risk) {
    return RISK_LABELS[risk] || RISK_LABELS.unknown;
  }

  function riskLabelKey(risk) {
    return RISK_LABEL_KEYS[risk] || RISK_LABEL_KEYS.unknown;
  }

  function riskBadgeColor(risk) {
    return RISK_BADGE_COLORS[risk] || null;
  }

  // Internal storage is pp/hour; the UI shows weekly rates as pp/day (§21.2).
  function burnRatePerDay(ratePpPerHour) {
    return Number.isFinite(ratePpPerHour) ? ratePpPerHour * 24 : null;
  }

  // "20%/h" for session windows, "5.1%/day" for weekly/billing.
  function formatBurnRate(ratePpPerHour, options = {}) {
    if (!Number.isFinite(ratePpPerHour)) return null;
    const unit = options.unit || 'hour';
    const value = unit === 'day' ? burnRatePerDay(ratePpPerHour) : ratePpPerHour;
    const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded}%/${unit === 'day' ? 'day' : 'h'}`;
  }

  // 90 minutes -> "1h 30m"; 28 minutes -> "28m"; 3.2 days -> "3.2 days".
  function formatDurationMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms >= 2 * DAY_MS) {
      const days = ms / DAY_MS;
      return `${Math.round(days * 10) / 10} days`;
    }
    const totalMinutes = Math.round(ms / (60 * 1000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  // A short clock time like "12:08" or "Mon 08:00" for an ISO timestamp,
  // rendered in the local timezone. `now` is only used for day-of-week choices.
  function formatEtaClock(isoTimestamp, nowMs = Date.now()) {
    const at = Date.parse(isoTimestamp || '');
    if (!Number.isFinite(at)) return null;
    const date = new Date(at);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const today = new Date(nowMs);
    const sameDay = date.toDateString() === today.toDateString();
    if (sameDay) return `${hours}:${minutes}`;
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${hours}:${minutes}`;
  }

  // The trigger line the tray tooltip shows for a WARNING/CRITICAL state (§20).
  // Pure: takes an already-localized label set so main and renderer can inject
  // their i18n.
  function forecastTooltipLine(globalRisk, options = {}) {
    const labels = options.labels || {};
    const trigger = globalRisk?.trigger;
    const risk = globalRisk?.risk;
    if (!trigger || (risk !== 'warning' && risk !== 'critical')) return null;
    const provider = trigger.provider || '';
    const windowName = trigger.windowLabel || trigger.windowKind || '';
    const remaining = Number.isFinite(trigger.remainingPercent)
      ? `${Math.round(trigger.remainingPercent)}%`
      : '';
    const eta = formatDurationMs(trigger.timeToExhaustionMs);
    const resetIn = formatDurationMs(trigger.timeToResetMs);
    const parts = [];
    const head = risk === 'critical'
      ? (labels.criticalHead || 'Quota critical')
      : (labels.warningHead || 'Quota warning');
    parts.push(`${head}: ${[provider, windowName].filter(Boolean).join(' ')}`);
    if (remaining) parts.push(`${labels.remaining || 'remaining'} ${remaining}`);
    if (eta) parts.push(`${labels.eta || 'ETA'} ${eta}`);
    if (resetIn) parts.push(`${labels.resetIn || 'reset in'} ${resetIn}`);
    if (trigger.exhaustionBeforeResetMs !== null && trigger.exhaustionBeforeResetMs > 0 && labels.beforeReset) {
      parts.push(labels.beforeReset(formatDurationMs(trigger.exhaustionBeforeResetMs)));
    }
    return parts.join(' · ');
  }

  // Weekly windows read better as pp/day; session stays pp/hour (§21.1, §21.2).
  function burnRateUnitForWindow(windowKind) {
    return windowKind === 'weekly' || windowKind === 'billing' ? 'day' : 'hour';
  }

  return {
    RISK_BADGE_COLORS,
    RISK_LABELS,
    burnRatePerDay,
    burnRateUnitForWindow,
    forecastTooltipLine,
    formatBurnRate,
    formatDurationMs,
    formatEtaClock,
    riskBadgeColor,
    riskLabel,
    riskLabelKey
  };
});
