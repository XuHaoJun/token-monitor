'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateQuotaRisk,
  calculateQuotaForecasts,
  dedupeSnapshots,
  extractQuotaSnapshots,
  segmentSnapshots,
  stableAccountIdentity
} = require('../../src/shared/quotaForecast');

const T0 = Date.parse('2026-08-14T00:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function iso(ms) {
  return new Date(ms).toISOString();
}

function snapshot(options) {
  const {
    at,
    used,
    resetsAt = T0 + 3 * HOUR,
    kind = 'session',
    label = '',
    provider = 'codex',
    accountKey = 'acct',
    metric = null,
    sourceUpdatedAt = null,
    observedAt = null
  } = options;
  const usedPercent = used;
  return {
    observedAt: observedAt !== null ? iso(observedAt) : iso(at),
    sourceUpdatedAt,
    provider,
    accountKey,
    persistable: true,
    windowKind: kind,
    windowLabel: label,
    metric,
    usedPercent,
    remainingPercent: Number((100 - usedPercent).toFixed(3)),
    resetsAt: iso(resetsAt)
  };
}

// Linear burn from `from` to `to` over `durationMs`, sampled every `stepMs`.
function burnSamples({
  from,
  to,
  start = T0,
  durationMs = HOUR,
  stepMs = 5 * MINUTE,
  ...extra
}) {
  const samples = [];
  for (let at = start; at <= start + durationMs; at += stepMs) {
    const t = (at - start) / durationMs;
    const used = from + (to - from) * t;
    samples.push(snapshot({ ...extra, at, used }));
  }
  return samples;
}

function forecast(snapshots, options = {}) {
  const list = calculateQuotaForecasts(snapshots, {
    nowMs: options.nowMs ?? T0 + HOUR,
    criticalEtaMs: options.criticalEtaMs ?? 60 * MINUTE,
    burstWarningEtaMs: options.burstWarningEtaMs ?? 30 * MINUTE,
    staleAfterMs: options.staleAfterMs ?? 20 * MINUTE,
    ...options
  });
  return list.length === 1 ? list[0] : list;
}

// 1. steady linear burn: 50 -> 70 over 1h = 20 pp/h, remaining 30, reset in 2h
//    from now -> ETA 1.5h -> exhausts 30m before reset -> WARNING.
test('steady linear burn yields the expected rate, ETA and warning risk', () => {
  const samples = burnSamples({ from: 50, to: 70 });
  const result = forecast(samples);
  assert.equal(result.risk, 'warning');
  assert.equal(result.riskReason, 'exhausts-before-reset');
  assert.equal(result.primaryLookback, '1h');
  assert.ok(Math.abs(result.primaryRate - 20) < 0.5, `rate ${result.primaryRate}`);
  assert.ok(Math.abs(result.rate15m - 20) < 1);
  assert.ok(Math.abs(result.rate1h - 20) < 0.5);
  const etaMs = Date.parse(result.estimatedExhaustionAt);
  const expectedEta = T0 + HOUR + (30 / 20) * HOUR;
  assert.ok(Math.abs(etaMs - expectedEta) < MINUTE, `eta ${new Date(etaMs).toISOString()}`);
  assert.ok(Math.abs(result.exhaustionBeforeResetMs - (30 * MINUTE)) < MINUTE);
  assert.equal(result.confidence, 'high');
  assert.equal(result.sampleCount, 13);
});

// 2. zero burn: flat samples -> no ETA, safe, "no current burn".
test('zero burn reports no ETA and stays safe', () => {
  const samples = burnSamples({ from: 50, to: 50 });
  const result = forecast(samples);
  assert.equal(result.primaryRate, 0);
  assert.equal(result.estimatedExhaustionAt, null);
  assert.equal(result.timeToExhaustionMs, null);
  assert.equal(result.risk, 'safe');
  assert.equal(result.riskReason, 'no-burn');
});

// 3. noisy percentage rounding still recovers the underlying rate.
test('noisy percentage rounding still recovers the underlying rate', () => {
  const samples = burnSamples({ from: 50, to: 70 });
  const noisy = samples.map((sample) => snapshot({
    at: Date.parse(sample.observedAt),
    used: Math.round(sample.usedPercent + (Math.random() - 0.5) * 0.8),
    resetsAt: T0 + 3 * HOUR
  }));
  const result = forecast(noisy);
  assert.ok(Math.abs(result.primaryRate - 20) < 1.5, `rate ${result.primaryRate}`);
  assert.equal(result.risk, 'warning');
});

// 4. resetsAt generation change: old-generation samples must not pull the
//    current slope down.
test('a resetsAt generation change never crosses the boundary', () => {
  const generation1 = burnSamples({
    from: 10, to: 98, start: T0 - 2 * HOUR, durationMs: 2 * HOUR, stepMs: 10 * MINUTE
  });
  const generation2 = burnSamples({
    from: 3, to: 23, start: T0, durationMs: HOUR, stepMs: 10 * MINUTE,
    resetsAt: T0 + 4 * HOUR
  });
  const result = forecast([...generation1, ...generation2], { nowMs: T0 + HOUR });
  // Generation 2 burns 20 pp/h; generation 1 ended at 98% which must not
  // poison the slope into something absurd.
  assert.ok(Math.abs(result.primaryRate - 20) < 1, `rate ${result.primaryRate}`);
  assert.ok(result.estimatedExhaustionAt !== null);
  assert.equal(result.risk, 'safe'); // remaining 77 at 20 pp/h outlives the 4h reset
});

// 5. usedPercent sudden decrease: 80 -> 30 is a local segment boundary, not a
//    giant negative burn rate.
test('a sudden usedPercent decrease starts a new local segment', () => {
  const before = burnSamples({ from: 60, to: 80, start: T0 - HOUR, durationMs: HOUR, stepMs: 10 * MINUTE });
  const corrected = burnSamples({
    from: 30, to: 50, start: T0, durationMs: HOUR, stepMs: 10 * MINUTE
  });
  const result = forecast([...before, ...corrected], { nowMs: T0 + HOUR });
  assert.ok(result.primaryRate > 0, `rate ${result.primaryRate}`);
  assert.ok(Math.abs(result.primaryRate - 20) < 1, `rate ${result.primaryRate}`);
  assert.equal(result.risk, 'safe');
});

// 6. insufficient samples: fewer than 3 or under 10 minutes span -> unknown.
test('insufficient samples produce an unknown forecast', () => {
  const two = [
    snapshot({ at: T0 - 10 * MINUTE, used: 50, resetsAt: T0 + 3 * HOUR }),
    snapshot({ at: T0, used: 55, resetsAt: T0 + 3 * HOUR })
  ];
  const result = forecast(two, { nowMs: T0 });
  assert.equal(result.primaryRate, null);
  assert.equal(result.confidence, 'insufficient');
  assert.equal(result.risk, 'unknown');
  assert.equal(result.riskReason, 'insufficient-data');
});

// 7. 15m burst on a session window escalates a safe 1h forecast to WARNING,
//    never straight to CRITICAL.
test('a 15m burst escalates a safe session forecast to warning only', () => {
  const slow = [];
  for (let at = T0 - HOUR; at <= T0 - 15 * MINUTE; at += 5 * MINUTE) {
    slow.push(snapshot({ at, used: 50, resetsAt: T0 + HOUR }));
  }
  const burst = [];
  const burstValues = [52, 60, 68, 76];
  for (let i = 0; i < burstValues.length; i += 1) {
    burst.push(snapshot({ at: T0 - 15 * MINUTE + i * 5 * MINUTE, used: burstValues[i], resetsAt: T0 + HOUR }));
  }
  const result = forecast([...slow, ...burst], { nowMs: T0 });
  assert.equal(result.risk, 'warning');
  assert.equal(result.riskReason, 'burst');
  // 15m rate must be much hotter than the 1h rate.
  assert.ok(result.rate15m > result.rate1h * 2, `15m=${result.rate15m} 1h=${result.rate1h}`);
});

// 8. weekly window: 24h is the primary forecast.
test('weekly windows forecast from the 24h rate', () => {
  const samples = burnSamples({
    from: 10, to: 20, start: T0 - 24 * HOUR, durationMs: 24 * HOUR, stepMs: 30 * MINUTE,
    kind: 'weekly', resetsAt: T0 + 5 * 24 * HOUR
  });
  const result = forecast(samples, { nowMs: T0 });
  assert.equal(result.primaryLookback, '24h');
  assert.ok(Math.abs(result.primaryRate - 10 / 24) < 0.05, `rate ${result.primaryRate}`);
  assert.equal(result.confidence, 'high');
  assert.equal(result.risk, 'safe');
});

// 9. weekly window with only 1h of data falls back to the 1h rate with low
//    confidence.
test('weekly windows fall back to 1h with low confidence', () => {
  const samples = burnSamples({
    from: 10, to: 20, start: T0 - HOUR, durationMs: HOUR, stepMs: 5 * MINUTE,
    kind: 'weekly', resetsAt: T0 + 3 * 24 * HOUR
  });
  const result = forecast(samples, { nowMs: T0 });
  assert.equal(result.primaryLookback, '1h');
  assert.equal(result.confidence, 'low');
  assert.ok(Math.abs(result.primaryRate - 10) < 0.5);
});

// 10. exhaustion after reset -> SAFE.
test('exhausting after reset is safe', () => {
  const samples = burnSamples({ from: 50, to: 70, resetsAt: T0 + 2 * HOUR + 20 * MINUTE });
  // ETA = T0+2.5h; reset = T0+2h20m -> the reset lands first, so the quota
  // survives.
  const result = forecast(samples, { nowMs: T0 + HOUR, staleAfterMs: 0 });
  assert.equal(result.risk, 'safe');
  assert.equal(result.riskReason, 'survives-reset');
});

// 11. exhaustion before reset -> WARNING (ETA > critical horizon).
test('exhausting before reset warns', () => {
  const samples = burnSamples({ from: 50, to: 70, resetsAt: T0 + 2 * HOUR + 36 * MINUTE });
  const result = forecast(samples, { nowMs: T0 + HOUR, staleAfterMs: 0 });
  // ETA = now + 1.5h; reset = now + 1.6h -> empty 6m before reset, ETA 90m
  // which is above the 60m critical horizon.
  assert.equal(result.risk, 'warning');
  assert.equal(result.riskReason, 'exhausts-before-reset');
});

// 12. ETA within the critical horizon -> CRITICAL.
test('an ETA inside the critical horizon is critical', () => {
  const samples = burnSamples({ from: 50, to: 80 });
  // 30 pp/h, remaining 20 -> ETA 40m <= 60m, and reset is far away.
  const result = forecast(samples, { nowMs: T0 + HOUR, staleAfterMs: 0 });
  assert.equal(result.risk, 'critical');
  assert.equal(result.riskReason, 'eta-critical');
  assert.ok(result.timeToExhaustionMs <= 60 * MINUTE);
});

// 13. remaining <= 5% with a distant reset is critical even without a rate.
test('remaining at or under 5% with a distant reset is directly critical', () => {
  const samples = [
    snapshot({ at: T0, used: 96, resetsAt: T0 + 30 * MINUTE })
  ];
  const result = forecast(samples, { nowMs: T0 });
  assert.equal(result.risk, 'critical');
  assert.equal(result.riskReason, 'nearly-empty');
});

// 14. credits windows are excluded from snapshots.
test('credits windows are excluded', () => {
  const stats = {
    limits: {
      refreshMs: 300_000,
      updatedAt: iso(T0),
      providers: [{
        provider: 'deepseek',
        accountKey: 'acct',
        status: 'ok',
        updatedAt: iso(T0),
        windows: [
          { kind: 'billing', metric: 'credits', usedPercent: 50, remainingPercent: 50, resetsAt: iso(T0 + HOUR) },
          { kind: 'billing', metric: 'spend', usedPercent: 40, remainingPercent: 60, resetsAt: iso(T0 + HOUR) }
        ]
      }]
    }
  };
  const snapshots = extractQuotaSnapshots(stats, { observedAt: T0 });
  assert.equal(snapshots.length, 0);
});

// 15. windows without resetsAt are excluded.
test('windows without resetsAt are excluded', () => {
  const stats = {
    limits: {
      refreshMs: 300_000,
      updatedAt: iso(T0),
      providers: [{
        provider: 'codex',
        accountKey: 'acct',
        status: 'ok',
        updatedAt: iso(T0),
        windows: [
          { kind: 'session', usedPercent: 50, remainingPercent: 50, resetsAt: null }
        ]
      }]
    }
  };
  assert.equal(extractQuotaSnapshots(stats, { observedAt: T0 }).length, 0);
});

// 16. stale observations must not keep an alarm alive.
test('stale observations degrade to unknown', () => {
  const samples = burnSamples({ from: 50, to: 80 });
  const result = forecast(samples, { nowMs: T0 + HOUR + 30 * MINUTE, staleAfterMs: 20 * MINUTE });
  assert.equal(result.risk, 'unknown');
  assert.equal(result.riskReason, 'stale');
  assert.ok(result.lastForecastAgeMs >= 30 * MINUTE);
});

// 16b. non-ok providers are excluded at extraction.
test('providers that are not ok are excluded at extraction', () => {
  const stats = {
    limits: {
      refreshMs: 300_000,
      updatedAt: iso(T0),
      providers: [{
        provider: 'codex',
        accountKey: 'acct',
        status: 'rateLimited',
        updatedAt: iso(T0),
        windows: [{ kind: 'session', usedPercent: 50, remainingPercent: 50, resetsAt: iso(T0 + HOUR) }]
      }]
    }
  };
  assert.equal(extractQuotaSnapshots(stats, { observedAt: T0 }).length, 0);
});

// 17. multiple accounts stay independent series.
test('multiple accounts are separate series', () => {
  const samples = [
    ...burnSamples({ from: 50, to: 70, accountKey: 'acct-a' }),
    ...burnSamples({ from: 20, to: 40, accountKey: 'acct-b' })
  ];
  const results = forecast(samples);
  assert.equal(results.length, 2);
  const a = results.find((item) => item.accountKey === 'acct-a');
  const b = results.find((item) => item.accountKey === 'acct-b');
  assert.ok(Math.abs(a.primaryRate - 20) < 0.5);
  assert.ok(Math.abs(b.primaryRate - 20) < 0.5);
  assert.equal(a.risk, 'warning');
  assert.equal(b.risk, 'safe');
});

// 18. distinct quota labels (e.g. weekly with a plan label) stay separate.
test('distinct quota labels are separate series', () => {
  const samples = [
    ...burnSamples({ kind: 'weekly', label: 'fable', from: 10, to: 30, start: T0 - HOUR, resetsAt: T0 + 3 * 24 * HOUR }),
    ...burnSamples({ kind: 'weekly', label: 'opus', from: 60, to: 75, start: T0 - HOUR, resetsAt: T0 + 3 * 24 * HOUR })
  ];
  const results = forecast(samples, { nowMs: T0 });
  assert.equal(results.length, 2);
  const fable = results.find((item) => item.windowLabel === 'fable');
  const opus = results.find((item) => item.windowLabel === 'opus');
  assert.ok(Math.abs(fable.primaryRate - 20) < 0.5);
  assert.ok(Math.abs(opus.primaryRate - 15) < 0.5);
  // Both burn fast enough to exhaust long before the weekly reset — both warn.
  assert.equal(fable.risk, 'warning');
  assert.equal(opus.risk, 'warning');
  assert.notEqual(fable.seriesKey, opus.seriesKey);
});

// 19. global aggregation picks the worst risk and its trigger.
test('global aggregation selects the worst risk with its trigger', () => {
  const safe = { seriesKey: 'a', provider: 'codex', windowKind: 'session', risk: 'safe', estimatedExhaustionAt: null };
  const warning = { seriesKey: 'b', provider: 'codex', windowKind: 'session', risk: 'warning', estimatedExhaustionAt: iso(T0 + HOUR), exhaustionBeforeResetMs: 30 * MINUTE, timeToResetMs: 2 * HOUR };
  const critical = { seriesKey: 'c', provider: 'claude', windowKind: 'session', risk: 'critical', estimatedExhaustionAt: iso(T0 + 20 * MINUTE), exhaustionBeforeResetMs: HOUR, timeToResetMs: 2 * HOUR };
  const aggregate = aggregateQuotaRisk([safe, warning, critical]);
  assert.equal(aggregate.risk, 'critical');
  assert.equal(aggregate.trigger.seriesKey, 'c');
});

// 19b. unknown never overrides an existing safe state.
test('unknown risks never override a safe state', () => {
  const aggregate = aggregateQuotaRisk([
    { seriesKey: 'a', provider: 'codex', windowKind: 'session', risk: 'unknown' },
    { seriesKey: 'b', provider: 'codex', windowKind: 'session', risk: 'safe' }
  ]);
  assert.equal(aggregate.risk, 'safe');
  assert.equal(aggregate.trigger.seriesKey, 'b');
});

// 19c. all-unknown aggregates to unknown; billing is excluded by default.
test('all-unknown aggregates to unknown and billing is excluded', () => {
  const allUnknown = aggregateQuotaRisk([
    { seriesKey: 'a', windowKind: 'session', risk: 'unknown' },
    { seriesKey: 'b', windowKind: 'weekly', risk: 'unknown' }
  ]);
  assert.equal(allUnknown.risk, 'unknown');
  const withBilling = aggregateQuotaRisk([
    { seriesKey: 'a', windowKind: 'session', risk: 'safe' },
    { seriesKey: 'b', windowKind: 'billing', risk: 'critical' }
  ]);
  assert.equal(withBilling.risk, 'safe');
  const includingBilling = aggregateQuotaRisk([
    { seriesKey: 'a', windowKind: 'session', risk: 'safe' },
    { seriesKey: 'b', windowKind: 'billing', risk: 'critical' }
  ], { includeBilling: true });
  assert.equal(includingBilling.risk, 'critical');
});

// 20. identical consecutive observations are rejected as duplicates.
test('duplicate snapshots are rejected', () => {
  const base = snapshot({ at: T0, used: 50, resetsAt: T0 + 3 * HOUR, sourceUpdatedAt: iso(T0 - 5 * MINUTE) });
  const duplicate = { ...base };
  const different = snapshot({ at: T0 + 5 * MINUTE, used: 52, resetsAt: T0 + 3 * HOUR, sourceUpdatedAt: iso(T0) });
  const deduped = dedupeSnapshots([base, duplicate, different]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].usedPercent, 50);
  assert.equal(deduped[1].usedPercent, 52);
});

// Extraction: series identity and persistable flag.
test('extraction builds snapshots with stable identity and persistable flag', () => {
  const stats = {
    limits: {
      refreshMs: 300_000,
      updatedAt: iso(T0 - MINUTE),
      providers: [{
        provider: 'codex',
        accountKey: 'sha256:abc',
        status: 'ok',
        updatedAt: iso(T0 - MINUTE),
        windows: [
          { kind: 'session', label: '', usedPercent: 72, remainingPercent: 28, resetsAt: iso(T0 + 2 * HOUR) },
          { kind: 'weekly', label: '', usedPercent: 43, remainingPercent: 57, resetsAt: iso(T0 + 4 * 24 * HOUR) }
        ]
      }, {
        provider: 'claude',
        accountKey: '',
        accountName: 'Work account',
        accountLabel: '',
        planLabel: '',
        status: 'ok',
        updatedAt: iso(T0 - MINUTE),
        windows: [
          { kind: 'session', label: '5-hour', usedPercent: 10, remainingPercent: 90, resetsAt: iso(T0 + HOUR) }
        ]
      }]
    }
  };
  const snapshots = extractQuotaSnapshots(stats, { observedAt: T0 });
  assert.equal(snapshots.length, 3);
  const codexSession = snapshots[0];
  assert.equal(codexSession.provider, 'codex');
  assert.equal(codexSession.accountKey, 'sha256:abc');
  assert.equal(codexSession.windowKind, 'session');
  assert.equal(codexSession.usedPercent, 72);
  assert.equal(codexSession.persistable, true);
  assert.equal(codexSession.observedAt, iso(T0));
  const claude = snapshots[2];
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.persistable, true);
  assert.ok(claude.accountKey.startsWith('sha256:'));
  // Email must never become the identity.
  assert.notEqual(claude.accountKey, 'user@example.com');
  assert.equal(stableAccountIdentity({ provider: 'x', accountKey: '', accountEmail: 'user@example.com' }), null);
});

// Segmentation: generation + correction boundaries produce the expected segments.
test('segmentation splits generations and corrections', () => {
  const gen1 = snapshot({ at: T0 - HOUR, used: 50, resetsAt: T0 + HOUR });
  const gen2a = snapshot({ at: T0, used: 5, resetsAt: T0 + 4 * HOUR });
  const gen2b = snapshot({ at: T0 + 10 * MINUTE, used: 8, resetsAt: T0 + 4 * HOUR });
  const correction = snapshot({ at: T0 + 20 * MINUTE, used: 3, resetsAt: T0 + 4 * HOUR });
  const segments = segmentSnapshots([gen1, gen2a, gen2b, correction]);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].samples.length, 1);
  assert.equal(segments[1].samples.length, 2);
  assert.equal(segments[2].samples.length, 1);
  assert.equal(segments[2].samples[0].usedPercent, 3);
});
