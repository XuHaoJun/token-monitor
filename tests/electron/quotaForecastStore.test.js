'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_RETENTION_MS,
  QUOTA_FORECAST_HISTORY_VERSION,
  corruptHistoryPath,
  createQuotaForecastStore,
  quotaForecastHistoryPath
} = require('../../src/electron/quotaForecastStore');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-14T12:00:00.000Z');

function tempDir() {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'quota-forecast-store-'));
}

function snapshot(observedAt, extra = {}) {
  return {
    observedAt: new Date(observedAt).toISOString(),
    sourceUpdatedAt: null,
    provider: 'codex',
    accountKey: 'acct',
    windowKind: 'session',
    windowLabel: '',
    metric: null,
    usedPercent: 50,
    remainingPercent: 50,
    resetsAt: new Date(observedAt + 2 * 60 * 60 * 1000).toISOString(),
    ...extra
  };
}

test('the history path is stable under userData', () => {
  assert.equal(
    quotaForecastHistoryPath('/tmp/user-data'),
    path.join('/tmp/user-data', 'quota-forecast-history.json')
  );
  assert.equal(
    quotaForecastHistoryPath('/tmp/user-data'),
    quotaForecastHistoryPath('/tmp/user-data')
  );
});

test('a missing file reads as empty history', () => {
  const dir = tempDir();
  const store = createQuotaForecastStore({
    historyPath: path.join(dir, 'quota-forecast-history.json'),
    nowMs: () => NOW
  });
  const result = store.read();
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshots, []);
});

test('load/save round trip preserves the snapshot list', async () => {
  const dir = tempDir();
  const historyPath = path.join(dir, 'quota-forecast-history.json');
  const store = createQuotaForecastStore({ historyPath, nowMs: () => NOW });
  const samples = [snapshot(NOW - DAY), snapshot(NOW - 2 * DAY)];
  assert.equal(await store.write(samples), true);
  const result = store.read();
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshots, samples);
  // The file on disk keeps the versioned shape.
  const raw = JSON.parse(fsSync.readFileSync(historyPath, 'utf8'));
  assert.equal(raw.version, QUOTA_FORECAST_HISTORY_VERSION);
  assert.equal(raw.snapshots.length, 2);
});

test('atomic replacement leaves no temporary files behind', async () => {
  const dir = tempDir();
  const historyPath = path.join(dir, 'quota-forecast-history.json');
  const store = createQuotaForecastStore({ historyPath, nowMs: () => NOW });
  await store.write([snapshot(NOW)]);
  await store.write([snapshot(NOW - 60 * 60 * 1000)]);
  const leftovers = fsSync.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(store.read().snapshots.length, 1);
});

test('prune drops snapshots older than the retention window', () => {
  const store = createQuotaForecastStore({
    historyPath: '/unused',
    retentionMs: 14 * DAY,
    nowMs: () => NOW
  });
  const samples = [
    snapshot(NOW - 1 * DAY),
    snapshot(NOW - 13 * DAY),
    snapshot(NOW - 15 * DAY),
    snapshot(NOW - 30 * DAY)
  ];
  const kept = store.prune(samples);
  assert.equal(kept.length, 2);
  assert.equal(Date.parse(kept[0].observedAt), NOW - 1 * DAY);
  assert.equal(Date.parse(kept[1].observedAt), NOW - 13 * DAY);
});

test('prune keeps the retention boundary when retention is custom', () => {
  const store = createQuotaForecastStore({
    historyPath: '/unused',
    retentionMs: 2 * DAY,
    nowMs: () => NOW
  });
  const kept = store.prune([
    snapshot(NOW - 2 * DAY),
    snapshot(NOW - 2 * DAY - 1)
  ]);
  assert.equal(kept.length, 1);
});

test('corrupt JSON is quarantined and history starts empty', () => {
  const dir = tempDir();
  const historyPath = path.join(dir, 'quota-forecast-history.json');
  fsSync.writeFileSync(historyPath, '{ not json !!!');
  const store = createQuotaForecastStore({ historyPath, nowMs: () => NOW });
  const result = store.read();
  assert.equal(result.ok, false);
  assert.deepEqual(result.snapshots, []);
  // The corrupt file was moved aside, not deleted.
  assert.equal(fsSync.existsSync(historyPath), false);
  const quarantine = fsSync.readdirSync(dir).filter((name) => name.includes('.corrupt.'));
  assert.equal(quarantine.length, 1);
  assert.match(quarantine[0], /^quota-forecast-history\.json\.corrupt\./);
});

test('a version mismatch is ignored without quarantine', () => {
  const dir = tempDir();
  const historyPath = path.join(dir, 'quota-forecast-history.json');
  fsSync.writeFileSync(historyPath, JSON.stringify({ version: 99, snapshots: [snapshot(NOW)] }));
  const store = createQuotaForecastStore({ historyPath, nowMs: () => NOW });
  const result = store.read();
  assert.equal(result.ok, false);
  assert.deepEqual(result.snapshots, []);
  assert.equal(fsSync.existsSync(historyPath), true);
});

test('write failures are fail-open and never throw', async () => {
  const store = createQuotaForecastStore({
    historyPath: path.join('/nonexistent-dir-xyz', 'quota-forecast-history.json'),
    nowMs: () => NOW
  });
  // The atomic writer creates the directory recursively, so force a failure
  // with a historyPath whose parent cannot be created.
  const badStore = createQuotaForecastStore({
    historyPath: path.join('/dev/null', 'quota-forecast-history.json'),
    nowMs: () => NOW
  });
  const result = await badStore.write([snapshot(NOW)]);
  assert.equal(result, false);
  // Missing file reads as fail-open empty history, not an error.
  const empty = store.read();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.snapshots, []);
});

test('corruptHistoryPath embeds a timestamp', () => {
  const stamped = corruptHistoryPath('/d/h.json', Date.parse('2026-08-14T12:00:00.000Z'));
  assert.match(stamped, /^\/d\/h\.json\.corrupt\.2026-08-14T12-00-00-000Z\.json$/);
  assert.notEqual(stamped, corruptHistoryPath('/d/h.json', Date.parse('2026-08-15T12:00:00.000Z')));
});

test('the default retention is 14 days', () => {
  assert.equal(DEFAULT_RETENTION_MS, 14 * 24 * 60 * 60 * 1000);
});

test('a real write survives a fresh store instance (restart recovery)', async () => {
  const dir = tempDir();
  const historyPath = path.join(dir, 'quota-forecast-history.json');
  const first = createQuotaForecastStore({ historyPath, nowMs: () => NOW });
  await first.write([snapshot(NOW, { usedPercent: 72 })]);
  const second = createQuotaForecastStore({ historyPath, nowMs: () => NOW });
  const result = second.read();
  assert.equal(result.ok, true);
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0].usedPercent, 72);
});
