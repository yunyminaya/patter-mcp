/**
 * Durable persistence tests for the local JSON store.
 *
 * Unlike db.test.ts (which runs against ":memory:"), these tests use a real
 * temp file and simulate a server restart with `vi.resetModules()` to prove
 * that records survive a process restart — the behaviour the old native
 * better-sqlite3 backend silently lost when its binary failed to load in the
 * bundled ESM build.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync, readFileSync } from "node:fs";
import type { CallRecord } from "./patter-server.js";

// Point the store at a real temp file BEFORE importing the module under test.
const DB_FILE = join(
  tmpdir(),
  `patter-mcp-persist-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);
process.env.PATTER_DB_PATH = DB_FILE;

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call_persist_" + Math.random().toString(36).slice(2, 10),
    direction: "outbound",
    status: "completed",
    startedAt: Date.now(),
    transcript: [],
    ...overrides,
  };
}

afterAll(() => {
  for (const f of [DB_FILE, `${DB_FILE}.tmp`]) {
    try {
      rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe("local JSON store — durable persistence", () => {
  it("is available and write-through persists records to the configured file", async () => {
    const db = await import("./db.js");
    db.initDb();

    expect(db.isDbAvailable()).toBe(true);
    expect(db.DB_PATH).toBe(DB_FILE);

    db.upsertCall(
      makeRecord({
        callId: "persist_1",
        to: "+14155550123",
        transcript: [{ role: "assistant", text: "hi" }],
        metrics: { cost: { total: 0.02 } },
      }),
    );

    expect(existsSync(DB_FILE)).toBe(true);
    const onDisk = JSON.parse(readFileSync(DB_FILE, "utf8")) as CallRecord[];
    expect(onDisk.map((r) => r.callId)).toContain("persist_1");
  });

  it("reloads persisted records after a simulated restart", async () => {
    // Drop the cached module so a fresh import re-reads the file from disk —
    // exactly what a process restart does.
    vi.resetModules();
    const fresh = await import("./db.js");
    fresh.initDb();

    const fetched = fresh.getCall("persist_1");
    expect(fetched).toBeDefined();
    expect(fetched!.to).toBe("+14155550123");
    expect(fetched!.transcript).toEqual([{ role: "assistant", text: "hi" }]);
    expect(fresh.sumHourlyCostUsd(0)).toBeGreaterThanOrEqual(0.02 - 1e-9);
  });
});
