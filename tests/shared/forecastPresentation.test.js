'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RISK_BADGE_COLORS,
  burnRatePerDay,
  burnRateUnitForWindow,
  forecastTooltipLine,
  formatBurnRate,
  formatDurationMs,
  formatEtaClock,
  riskBadgeColor,
  riskLabel
} = require('../../src/shared/forecastPresentation');

const T0 = Date.parse('2026-08-14T12:00:00.000Z');

test('risk labels map to uppercase tokens', () => {
  assert.equal(riskLabel('critical'), 'CRITICAL');
  assert.equal(riskLabel('warning'), 'WARNING');
  assert.equal(riskLabel('safe'), 'SAFE');
  assert.equal(riskLabel('unknown'), 'UNKNOWN');
  assert.equal(riskLabel('bogus'), 'UNKNOWN');
});

test('risk badge colors are explicit amber and red', () => {
  assert.equal(RISK_BADGE_COLORS.warning, '#f5a623');
  assert.equal(RISK_BADGE_COLORS.critical, '#e5484d');
  assert.equal(riskBadgeColor('safe'), null);
  assert.equal(riskBadgeColor('unknown'), null);
});

test('burn rates render as pp/h and pp/day', () => {
  assert.equal(formatBurnRate(20), '20%/h');
  assert.equal(formatBurnRate(5.13, { unit: 'day' }), '123%/day');
  assert.equal(formatBurnRate(24.4), '24%/h');
  assert.equal(formatBurnRate(0.5), '0.5%/h');
  assert.equal(formatBurnRate(null), null);
  assert.ok(Math.abs(burnRatePerDay(5.1) - 122.4) < 1e-9);
});

test('burn rate unit depends on the window kind', () => {
  assert.equal(burnRateUnitForWindow('session'), 'hour');
  assert.equal(burnRateUnitForWindow('weekly'), 'day');
  assert.equal(burnRateUnitForWindow('billing'), 'day');
});

test('durations format compactly', () => {
  assert.equal(formatDurationMs(90 * 60 * 1000), '1h 30m');
  assert.equal(formatDurationMs(28 * 60 * 1000), '28m');
  assert.equal(formatDurationMs(60 * 60 * 1000), '1h');
  assert.equal(formatDurationMs(3.2 * 24 * 60 * 60 * 1000), '3.2 days');
  assert.equal(formatDurationMs(-5), null);
  assert.equal(formatDurationMs(null), null);
});

test('eta clock renders local time with a weekday when needed', () => {
  // Same local day as `now` -> "12:08"; different day -> weekday prefix.
  const laterSameDay = T0 + 8 * 60 * 1000;
  const clock = formatEtaClock(new Date(laterSameDay).toISOString(), T0);
  assert.match(clock, /^\d{2}:\d{2}$/);
  const nextDay = formatEtaClock(new Date(T0 + 24 * 60 * 60 * 1000).toISOString(), T0);
  assert.match(nextDay, /^[A-Za-z]{3} \d{2}:\d{2}$/);
  assert.equal(formatEtaClock('not-a-date'), null);
});

test('the tooltip line summarizes a warning trigger', () => {
  const globalRisk = {
    risk: 'warning',
    trigger: {
      provider: 'codex',
      windowLabel: '5-hour',
      remainingPercent: 28,
      timeToExhaustionMs: 90 * 60 * 1000,
      timeToResetMs: 125 * 60 * 1000,
      exhaustionBeforeResetMs: 35 * 60 * 1000
    }
  };
  const line = forecastTooltipLine(globalRisk, {
    labels: {
      criticalHead: 'Quota critical',
      warningHead: 'Quota warning',
      remaining: 'remaining',
      eta: 'ETA',
      resetIn: 'reset in',
      beforeReset: (duration) => `Expected empty ${duration} before reset`
    }
  });
  assert.match(line, /^Quota warning: codex 5-hour/);
  assert.match(line, /remaining 28%/);
  assert.match(line, /ETA 1h 30m/);
  assert.match(line, /reset in 2h 5m/);
  assert.match(line, /Expected empty 35m before reset/);
});

test('safe or absent triggers produce no tooltip line', () => {
  assert.equal(forecastTooltipLine({ risk: 'safe', trigger: null }), null);
  assert.equal(forecastTooltipLine({ risk: 'warning', trigger: null }), null);
  assert.equal(forecastTooltipLine(null), null);
});

test('critical tooltips use the critical head', () => {
  const line = forecastTooltipLine({
    risk: 'critical',
    trigger: { provider: 'codex', windowLabel: '5-hour', remainingPercent: 12, timeToExhaustionMs: 28 * 60 * 1000, timeToResetMs: 104 * 60 * 1000, exhaustionBeforeResetMs: 76 * 60 * 1000 }
  }, { labels: { criticalHead: 'Quota critical', warningHead: 'Quota warning' } });
  assert.match(line, /^Quota critical/);
});
