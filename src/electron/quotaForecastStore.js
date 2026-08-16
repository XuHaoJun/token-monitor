'use strict';

// Quota forecast history persistence (tech spec §10).
//
// V1 keeps forecast snapshots in a single JSON file under Electron userData:
//   <userData>/quota-forecast-history.json
// (Linux example: ~/.config/Token Monitor/quota-forecast-history.json — the
// actual path always comes from app.getPath('userData') via the controller).
//
// Design rules from the spec, enforced here:
// - No SQLite, no new dependencies (§10.2).
// - File shape { version: 1, snapshots: [] } (§10.3).
// - 14-day retention by default (§10.4).
// - Atomic writes (temp + fsync + rename) reusing the upstream helper (§10.5).
// - Corrupt files are quarantined and the app starts with empty history; the
//   forecast then reports insufficient data instead of blocking startup (§10.6).
// - Every failure is fail-open: read/write errors never throw into the caller.

const path = require('node:path');
const { writePrivateBufferAtomic } = require('./macWidgetHistoryStore');

const QUOTA_FORECAST_HISTORY_VERSION = 1;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function quotaForecastHistoryPath(userDataDir) {
  return path.join(userDataDir, 'quota-forecast-history.json');
}

function corruptHistoryPath(historyPath, nowMs = Date.now()) {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${historyPath}.corrupt.${stamp}.json`;
}

function createQuotaForecastStore(options = {}) {
  const historyPath = String(options.historyPath || '');
  // read() is sync (small file, fail-open); the atomic writer needs the
  // promise API, so they take separate injectable handles.
  const fsSync = options.fsSync || require('node:fs');
  const fsPromises = options.fsPromises || require('node:fs/promises');
  const logger = options.logger || (() => {});
  const retentionMs = Number.isFinite(options.retentionMs)
    ? options.retentionMs
    : DEFAULT_RETENTION_MS;
  const nowMs = () => (typeof options.nowMs === 'function' ? options.nowMs() : Date.now());

  function safeLog(message) {
    try { logger(`[quota-forecast] ${message}`); } catch (_) {}
  }

  // Read the history file. Returns { ok, snapshots } — never throws. A missing
  // file yields empty history; a corrupt file is moved aside so the next write
  // starts clean and the app keeps running (§10.6).
  function read() {
    if (!historyPath) return { ok: false, snapshots: [] };
    let raw;
    try {
      raw = fsSync.readFileSync(historyPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, snapshots: [] };
      safeLog(`history read failed: ${error.message}`);
      return { ok: false, snapshots: [] };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      safeLog(`history corrupt, quarantining: ${error.message}`);
      try {
        fsSync.renameSync(historyPath, corruptHistoryPath(historyPath, nowMs()));
      } catch (renameError) {
        safeLog(`quarantine rename failed: ${renameError.message}`);
      }
      return { ok: false, snapshots: [] };
    }
    if (parsed?.version !== QUOTA_FORECAST_HISTORY_VERSION) {
      // Written by an incompatible app version; ignore without destroying it.
      safeLog(`history version ${String(parsed?.version)} ignored`);
      return { ok: false, snapshots: [] };
    }
    const snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
    return { ok: true, snapshots };
  }

  // Atomic write of the full snapshot list (§10.5). Fail-open: a failed write
  // must never crash the widget — the next successful update retries.
  async function write(snapshots) {
    if (!historyPath) return false;
    try {
      const serialized = JSON.stringify({
        version: QUOTA_FORECAST_HISTORY_VERSION,
        snapshots
      });
      await writePrivateBufferAtomic(historyPath, serialized, { fs: fsPromises });
      return true;
    } catch (error) {
      safeLog(`history write failed: ${error.message}`);
      return false;
    }
  }

  // Drop snapshots older than the retention window (§10.4).
  function prune(snapshots) {
    const cutoff = nowMs() - retentionMs;
    const kept = [];
    for (const snapshot of snapshots || []) {
      const at = Date.parse(snapshot?.observedAt || '');
      if (Number.isFinite(at) && at >= cutoff) kept.push(snapshot);
    }
    return kept;
  }

  return {
    historyPath,
    prune,
    read,
    retentionMs,
    write
  };
}

module.exports = {
  DEFAULT_RETENTION_MS,
  QUOTA_FORECAST_HISTORY_VERSION,
  corruptHistoryPath,
  createQuotaForecastStore,
  quotaForecastHistoryPath
};
