import { describe, it, expect, vi } from "vitest";
import { getMetricsHandler } from "./get-metrics.js";
import type { PatterServer, CallRecord } from "../patter-server.js";

function rec(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "c1",
    direction: "outbound",
    status: "completed",
    outcome: "answered",
    startedAt: 0,
    duration: 30,
    transcript: [],
    metrics: { cost: { total: 0.05 } },
    ...overrides,
  };
}

function mockPatter(record?: CallRecord): PatterServer {
  return { getCallForUser: vi.fn(() => record) } as unknown as PatterServer;
}

describe("getMetricsHandler", () => {
  it("returns cost + duration for a known call", () => {
    const res = getMetricsHandler({ callId: "c1" }, mockPatter(rec()));

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({
      callId: "c1",
      costUsd: 0.05,
      durationSeconds: 30,
      outcome: "answered",
    });
    expect(res.content[0].text).toContain("$0.0500");
  });

  it("enforces ownership / errors for an unknown call", () => {
    const res = getMetricsHandler({ callId: "nope" }, mockPatter(undefined));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No call found");
  });
});
