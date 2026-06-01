import { describe, it, expect, vi } from "vitest";
import { endCallHandler } from "./end-call.js";
import type { PatterServer } from "../patter-server.js";

function mockPatter(endCallImpl: () => Promise<void>): PatterServer {
  return { endCall: vi.fn(endCallImpl) } as unknown as PatterServer;
}

describe("endCallHandler", () => {
  it("requests hang-up and returns structured status", async () => {
    const patter = mockPatter(() => Promise.resolve());
    const res = await endCallHandler({ callId: "CA1" }, patter);

    expect(patter.endCall).toHaveBeenCalledWith("CA1");
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ callId: "CA1", status: "hangup_requested" });
  });

  it("returns an error result when endCall throws", async () => {
    const patter = mockPatter(() => Promise.reject(new Error("no such call")));
    const res = await endCallHandler({ callId: "CA2" }, patter);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("no such call");
  });
});
