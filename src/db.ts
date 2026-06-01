/**
 * Local persistence layer for call records.
 *
 * Stores call records in a single local JSON file with write-through and
 * atomic replacement (temp file + rename). Zero native dependencies: this
 * replaces the former better-sqlite3 backend, whose native binary could not be
 * dynamically required from the bundled ESM `dist/index.js` ("Dynamic require
 * of better-sqlite3 is not supported"), forcing a lossy in-memory fallback.
 *
 * "Local" was always the intent — SQLite was just a file too — so this keeps
 * everything local while removing the native binary + ESM-bundling friction.
 * Call volume for an MCP phone agent is modest and the process is single
 * threaded, so a write-through JSON file is more than sufficient.
 *
 * When `PATTER_DB_PATH` is ":memory:" the store is pure in-memory (no disk
 * I/O) — used by tests.
 *
 * Immutability: reads always return deep clones so callers can never mutate
 * the backing store, and writes clone the incoming record before storing it.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

import type { CallRecord } from "./patter-server.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[patter-db] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Path to the local JSON store. ":memory:" disables disk I/O (tests). */
export const DB_PATH = process.env.PATTER_DB_PATH ?? "patter-mcp.json";

const IN_MEMORY = DB_PATH === ":memory:";

// ---------------------------------------------------------------------------
// State (module-level singleton)
// ---------------------------------------------------------------------------

const store = new Map<string, CallRecord>();
let _loaded = false;
let _available = false;

/** Returns true once the local store has been initialised. */
export function isDbAvailable(): boolean {
  return _available;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// Disk I/O — atomic write-through
// ---------------------------------------------------------------------------

/**
 * Persist the entire store to disk atomically: write to a temp file then
 * rename over the target (rename is atomic on POSIX). No-op in memory mode.
 */
function flush(): void {
  if (IN_MEMORY) return;
  const data = JSON.stringify(Array.from(store.values()));
  const tmp = `${DB_PATH}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, DB_PATH);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the local store: load existing records from disk (if any).
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * A missing or corrupt store file is not fatal: the store starts empty and the
 * file is overwritten on the next write. The store is always "available" —
 * unlike the old native backend, there is no environment in which it fails.
 */
export function initDb(): void {
  if (_loaded) return;
  _loaded = true;

  try {
    if (!IN_MEMORY && existsSync(DB_PATH)) {
      const records = JSON.parse(readFileSync(DB_PATH, "utf8")) as unknown;
      if (Array.isArray(records)) {
        for (const r of records as CallRecord[]) {
          if (r && typeof r.callId === "string") store.set(r.callId, r);
        }
      }
    }
    _available = true;
    log(
      IN_MEMORY
        ? "Local store ready (in-memory)"
        : `Local store ready at ${DB_PATH} (${store.size} record(s))`,
    );
  } catch (err) {
    // Corrupt/unreadable file — start empty rather than crash. Still available;
    // the next write replaces the bad file.
    log(
      `WARNING: could not read ${DB_PATH}, starting empty. ` +
        `Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    store.clear();
    _available = true;
  }
}

/** Insert or update a call record, persisting to disk write-through. */
export function upsertCall(record: CallRecord): void {
  if (!_available) return;
  store.set(record.callId, clone(record));
  try {
    flush();
  } catch (err) {
    log(
      `WARNING: failed to persist ${record.callId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Retrieve a single call by ID, or `undefined` when not found. */
export function getCall(callId: string): CallRecord | undefined {
  if (!_available) return undefined;
  const record = store.get(callId);
  return record ? clone(record) : undefined;
}

/** Most-recent-first ordering helper. */
function byStartedAtDesc(records: CallRecord[]): CallRecord[] {
  return records.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Return all calls belonging to `userId`, or every call when `userId` is
 * `undefined` (unauthenticated / admin mode), most recent first.
 */
export function getCallsByUser(userId?: string): CallRecord[] {
  if (!_available) return [];
  const all = Array.from(store.values());
  const filtered = userId !== undefined ? all.filter((r) => r.userId === userId) : all;
  return byStartedAtDesc(filtered).map(clone);
}

/** Return every call record, most recent first. */
export function getAllCalls(): CallRecord[] {
  if (!_available) return [];
  return byStartedAtDesc(Array.from(store.values())).map(clone);
}

/**
 * Count outbound calls placed by `userId` since `sinceMs` (epoch ms).
 */
export function countDailyCallsByUser(userId: string, sinceMs: number): number {
  if (!_available) return 0;
  let count = 0;
  for (const r of store.values()) {
    if (r.userId === userId && r.direction === "outbound" && r.startedAt >= sinceMs) {
      count++;
    }
  }
  return count;
}

/**
 * Count active (ringing or in-progress) outbound calls for `userId`.
 */
export function countConcurrentCallsByUser(userId: string): number {
  if (!_available) return 0;
  let count = 0;
  for (const r of store.values()) {
    if (
      r.userId === userId &&
      r.direction === "outbound" &&
      (r.status === "ringing" || r.status === "in-progress")
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Sum estimated call costs (`metrics.cost.total`) for all outbound calls
 * started since `sinceMs`. Returns 0 when no metrics are recorded.
 */
export function sumHourlyCostUsd(sinceMs: number): number {
  if (!_available) return 0;
  let total = 0;
  for (const r of store.values()) {
    if (r.direction !== "outbound" || r.startedAt < sinceMs || !r.metrics) continue;
    const cost = (r.metrics as Record<string, unknown>).cost as
      | Record<string, unknown>
      | undefined;
    if (typeof cost?.total === "number") {
      total += cost.total;
    }
  }
  return total;
}
