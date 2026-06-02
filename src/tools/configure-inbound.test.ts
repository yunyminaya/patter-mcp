import { describe, it, expect, vi } from "vitest";
import { configureInboundHandler } from "./configure-inbound.js";
import type { PatterServer } from "../patter-server.js";

function mockPatter(reconfigureImpl: () => Promise<void>): PatterServer {
  return {
    reconfigureInbound: vi.fn(reconfigureImpl),
    phoneNumber: "+15555550100",
  } as unknown as PatterServer;
}

describe("configureInboundHandler", () => {
  it("reconfigures the inbound agent and returns structured status", async () => {
    const patter = mockPatter(() => Promise.resolve());
    const res = await configureInboundHandler(
      { systemPrompt: "Answer politely", engineMode: "openai_realtime", voice: "alloy" },
      patter,
    );

    expect(patter.reconfigureInbound).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: "Answer politely", engineMode: "openai_realtime" }),
    );
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      status: "configured",
      phoneNumber: "+15555550100",
      engineMode: "openai_realtime",
    });
  });

  it("defaults the engine mode to pipeline in the response", async () => {
    const patter = mockPatter(() => Promise.resolve());
    const res = await configureInboundHandler({ systemPrompt: "x" }, patter);
    expect(res.structuredContent?.engineMode).toBe("pipeline");
  });

  it("returns an error result when reconfiguration fails", async () => {
    const patter = mockPatter(() => Promise.reject(new Error("bad provider key")));
    const res = await configureInboundHandler({ systemPrompt: "x" }, patter);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("bad provider key");
  });
});
