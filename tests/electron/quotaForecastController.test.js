'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createQuotaForecastController } = require('../../src/electron/quotaForecastController');

const T0 = Date.parse('2026-08-14T00:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function iso(ms) {
  return new Date(ms).toISOString();
}

// Authoritative normalized limits update shaped like stats.limits.
function statsFor(usedPercent, atMs, options = {}) {
  return {
    limits: {
      refreshMs: 300_000,
      updatedAt: iso(atMs),
      providers: [{
        provider: options.provider || 'codex',
        accountKey: options.accountKey || 'acct',
        status: 'ok',
        updatedAt: iso(atMs),
        windows: [{
          kind: options.kind || 'session',
          label: options.label || '',
          usedPercent,
          remainingPercent: Number((100 - usedPercent).toFixed(3)),
          resetsAt: iso(options.resetsAt || atMs + 3 * HOUR)
        }]
      }]
    }
  };
}

function memoryStore() {
  let saved = [];
  return {
    read: () => ({ ok: true, snapshots: saved }),
    write: async (snapshots) => { saved = [...snapshots]; return true; },
    prune: (snapshots) => snapshots,
    saved: () => saved
  };
}

function makeController(options = {}) {
  const store = options.store || memoryStore();
  let clock = options.now || T0;
  const settings = options.settings || {};
  const controller = createQuotaForecastController({
    store,
    recheckIntervalMs: 0,
    getSettings: () => settings,
    nowMs: () => clock,
    emit: options.emit || (() => {}),
    logger: options.logger || (() => {})
  });
  return {
    controller,
    store,
    advance: (ms) => { clock += ms; }
  };
}

// Feed a linear burn from `from` to `to` as 13 authoritative updates, 5m apart,
// advancing the controller clock with each one (like real 5-minute refreshes).
async function feedBurn(controller, advance, from, to, options = {}) {
  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const used = from + ((to - from) * i) / steps;
    const at = T0 + i * 5 * MINUTE;
    await controller.update(statsFor(used, at, {
      resetsAt: options.resetsAt || T0 + 3 * HOUR,
      provider: options.provider,
      accountKey: options.accountKey
    }));
    if (i < steps) advance(5 * MINUTE);
  }
}

test('duplicate observations are not appended', async () => {
  const { controller, store } = makeController();
  await controller.start();
  // Same observation repeated (SSE replay / tray redraw) must not append.
  await controller.update(statsFor(50, T0));
  await controller.update(statsFor(50, T0));
  // A genuinely new observation does.
  await controller.update(statsFor(52, T0 + 5 * MINUTE));
  assert.equal(store.saved().length, 2);
  assert.equal(store.saved()[0].usedPercent, 50);
  assert.equal(store.saved()[1].usedPercent, 52);
});

test('a real burn appends history and drives the forecast', async () => {
  const { controller, store, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 50, 70);
  assert.equal(store.saved().length, 13);
  const state = controller.getState();
  assert.equal(state.forecasts.length, 1);
  assert.equal(state.globalRisk.risk, 'warning');
  assert.equal(state.globalRisk.trigger.seriesKey, 'codex:acct:session::');
  assert.equal(state.enabled, true);
});

test('restart recovers history from the store', async () => {
  const { controller, store, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 50, 70);
  // Simulate an app restart: a fresh controller over the same store, with the
  // wall clock where the previous run left it.
  const { controller: restarted } = makeController({ store, now: T0 + HOUR });
  await restarted.start();
  assert.equal(restarted.getState().forecasts.length, 1);
  assert.equal(restarted.getState().globalRisk.risk, 'warning');
});

test('hysteresis: a downgrade needs two consecutive safer snapshots', async () => {
  const { controller, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 50, 70);
  assert.equal(controller.getState().globalRisk.risk, 'warning');
  // Feed flat samples until the burn ages out of the 1h lookback. The first
  // update whose computed risk is safe must be held at warning; the second
  // consecutive safer snapshot flips to safe.
  let held = false;
  let becameSafe = false;
  for (let i = 0; i < 40 && !becameSafe; i += 1) {
    advance(5 * MINUTE);
    const at = T0 + 65 * MINUTE + i * 5 * MINUTE;
    await controller.update(statsFor(70, at, { resetsAt: T0 + 3 * HOUR }));
    const state = controller.getState();
    if (state.globalRisk.trigger?.hysteresisPending === true) held = true;
    if (state.globalRisk.risk === 'safe') becameSafe = true;
  }
  assert.equal(becameSafe, true, 'downgrade must eventually land on safe');
  assert.equal(held, true, 'the first safer snapshot must be held by hysteresis');
});

test('hysteresis: an upgrade is immediate', async () => {
  const { controller, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 50, 52);
  assert.equal(controller.getState().globalRisk.risk, 'safe');
  // A steep second burn: the very next forecast is critical and must apply
  // immediately, with no hysteresis hold.
  await feedBurn(controller, advance, 52, 90, { resetsAt: T0 + 3 * HOUR });
  const state = controller.getState();
  assert.equal(state.globalRisk.risk, 'critical');
  assert.notEqual(state.globalRisk.trigger?.hysteresisPending, true);
});

test('a reset generation change re-evaluates immediately', async () => {
  const { controller, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 50, 70);
  assert.equal(controller.getState().globalRisk.risk, 'warning');
  // New generation with a fresh quota: three samples in 10 minutes are enough
  // for a rate, and the generation change must bypass hysteresis.
  advance(5 * MINUTE);
  await controller.update(statsFor(3, T0 + 65 * MINUTE, { resetsAt: T0 + 5 * HOUR }));
  advance(5 * MINUTE);
  await controller.update(statsFor(4, T0 + 70 * MINUTE, { resetsAt: T0 + 5 * HOUR }));
  advance(5 * MINUTE);
  await controller.update(statsFor(5, T0 + 75 * MINUTE, { resetsAt: T0 + 5 * HOUR }));
  const state = controller.getState();
  assert.equal(state.globalRisk.risk, 'safe');
  assert.notEqual(state.globalRisk.trigger?.hysteresisPending, true);
});

test('stale observations degrade to unknown on recheck', async () => {
  const { controller, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 50, 80);
  assert.equal(controller.getState().globalRisk.risk, 'critical');
  // No new stats for 30 minutes: the periodic recheck must clear the alarm.
  advance(30 * MINUTE);
  controller.recheck();
  const state = controller.getState();
  assert.equal(state.globalRisk.risk, 'unknown');
  assert.equal(state.globalRisk.trigger.riskReason, 'stale');
});

test('forecast errors fail open to unknown', async () => {
  const store = {
    read: () => { throw new Error('read boom'); },
    write: async () => false,
    prune: (snapshots) => snapshots
  };
  const { controller } = makeController({ store });
  await controller.start();
  await controller.update(statsFor(50, T0));
  assert.equal(controller.getState().globalRisk.risk, 'unknown');
});

test('enabled flag follows settings', async () => {
  const settings = { predictiveQuotaAlertsEnabled: false };
  const { controller, advance } = makeController({ settings });
  await controller.start();
  await feedBurn(controller, advance, 50, 90);
  assert.equal(controller.getState().enabled, false);
});

test('multiple providers aggregate to the worst risk', async () => {
  const { controller, advance } = makeController();
  await controller.start();
  await feedBurn(controller, advance, 20, 40, { accountKey: 'acct-a' });
  await feedBurn(controller, advance, 60, 75, { accountKey: 'acct-b', resetsAt: T0 + 4 * HOUR });
  const state = controller.getState();
  assert.equal(state.forecasts.length, 2);
  assert.equal(state.globalRisk.risk, 'warning');
  assert.equal(state.globalRisk.trigger.accountKey, 'acct-b');
});
