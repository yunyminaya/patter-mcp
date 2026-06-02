import { describe, it, expect, vi, beforeAll } from "vitest";
import { makeCallHandler, planCall } from "./make-call.js";
import type { PatterServer, CallRecord } from "../patter-server.js";

// ---------------------------------------------------------------------------
// Minimal mock PatterServer
// ---------------------------------------------------------------------------

function makeCompletedRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call_abc_123",
    to: "+15551234567",
    direction: "outbound",
    status: "completed",
    outcome: "answered",
    startedAt: Date.now() - 30_000,
    endedAt: Date.now(),
    duration: 30,
    transcript: [
      { role: "assistant", text: "Hi there, how can I help?" },
      { role: "user", text: "Just testing." },
    ],
    metrics: { cost: { total: 0.02 } },
    ...overrides,
  };
}

function makeMockPatter(
  makeCallImpl: () => Promise<CallRecord>,
): PatterServer {
  return {
    makeCall: vi.fn(makeCallImpl),
    getCallsForUser: vi.fn(() => new Map()),
    getCallForUser: vi.fn(),
    callThirdParty: vi.fn(),
    startServer: vi.fn(),
    simulateCallEnd: vi.fn(),
    disconnect: vi.fn(),
    calls: new Map(),
    phoneNumber: "+15550000000",
    isServerRunning: false,
  } as unknown as PatterServer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeCallHandler", () => {
  it("returns success content with the completed call details", async () => {
    // Arrange
    const patter = makeMockPatter(() => Promise.resolve(makeCompletedRecord()));

    // Act
    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Be helpful" },
      patter,
      "user-1",
    );

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("call_abc_123");
    expect(result.content[0].text).toContain("+15551234567");
    expect(result.content[0].text).toContain("completed");
  });

  it("surfaces the carrier outcome and the transcript", async () => {
    const patter = makeMockPatter(() =>
      Promise.resolve(makeCompletedRecord({ outcome: "voicemail" })),
    );

    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Leave a message" },
      patter,
    );

    const text = result.content[0].text;
    expect(text).toContain("Outcome: voicemail");
    expect(text).toContain("[assistant] Hi there, how can I help?");
    expect(text).toContain("[user] Just testing.");
  });

  it("includes the duration in the success message", async () => {
    const patter = makeMockPatter(() =>
      Promise.resolve(makeCompletedRecord({ duration: 42 })),
    );

    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Help" },
      patter,
    );

    expect(result.content[0].text).toContain("Duration: 42s");
  });

  it("passes all options to patter.makeCall", async () => {
    const patter = makeMockPatter(() =>
      Promise.resolve(makeCompletedRecord({ callId: "call_options" })),
    );

    await makeCallHandler(
      {
        to: "+15559999999",
        systemPrompt: "Greet the caller",
        firstMessage: "Hi there!",
        voice: "alloy",
        machineDetection: true,
        voicemailMessage: "Please call back.",
      },
      patter,
      "user-42",
    );

    expect(patter.makeCall).toHaveBeenCalledWith({
      to: "+15559999999",
      systemPrompt: "Greet the caller",
      firstMessage: "Hi there!",
      voice: "alloy",
      machineDetection: true,
      voicemailMessage: "Please call back.",
      userId: "user-42",
    });
  });

  it("exposes a transcript resource link in the structured output", async () => {
    const patter = makeMockPatter(() =>
      Promise.resolve(makeCompletedRecord({ callId: "call_hints_test" })),
    );

    const result = await makeCallHandler(
      { to: "+15551112222", systemPrompt: "Help" },
      patter,
    );

    expect(result.structuredContent?.transcriptUri).toBe(
      "patter://call/call_hints_test/transcript",
    );
    expect(result.structuredContent?.callId).toBe("call_hints_test");
  });

  it("returns an error result when patter.makeCall throws", async () => {
    // Arrange
    const patter = makeMockPatter(() => Promise.reject(new Error("Twilio unavailable")));

    // Act
    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Be helpful" },
      patter,
      "user-1",
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to place call");
    expect(result.content[0].text).toContain("Twilio unavailable");
  });

  it("handles non-Error thrown values gracefully", async () => {
    const patter = makeMockPatter(() => Promise.reject("string error"));

    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Help" },
      patter,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("string error");
  });

  it("works without a userId (unauthenticated mode)", async () => {
    const patter = makeMockPatter(() =>
      Promise.resolve(makeCompletedRecord({ callId: "call_no_auth" })),
    );

    const result = await makeCallHandler(
      { to: "+15550001111", systemPrompt: "Hello" },
      patter,
    );

    expect(result.isError).toBeUndefined();
    expect(patter.makeCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined }),
    );
  });

  it("returns structured content mirroring the call result", async () => {
    const patter = makeMockPatter(() =>
      Promise.resolve(
        makeCompletedRecord({ callId: "call_struct", duration: 30, outcome: "answered" }),
      ),
    );

    const result = await makeCallHandler({ to: "+15551234567", systemPrompt: "x" }, patter);

    expect(result.structuredContent).toMatchObject({
      status: "completed",
      callId: "call_struct",
      outcome: "answered",
      durationSeconds: 30,
      costUsd: 0.02,
    });
  });
});

describe("planCall (dry run)", () => {
  beforeAll(() => {
    process.env.DEEPGRAM_API_KEY = "test-dg";
    process.env.ELEVENLABS_API_KEY = "test-el";
    process.env.OPENAI_API_KEY = "sk-test";
  });

  it("returns a resolved plan + cost estimate without placing a call", () => {
    const { plan, estimatedCostUsd } = planCall({
      to: "+15551234567",
      systemPrompt: "x",
      ttsProvider: "elevenlabs",
    });
    expect(plan.to).toBe("+15551234567");
    expect(plan.engineMode).toBe("pipeline");
    expect(plan.sttProvider).toBe("deepgram");
    expect(plan.ttsProvider).toBe("elevenlabs");
    expect(estimatedCostUsd).toBeGreaterThan(0);
  });

  it("throws a clear error on an invalid provider", () => {
    expect(() =>
      planCall({ to: "+15551234567", systemPrompt: "x", sttProvider: "bogus" as never }),
    ).toThrow(/Unknown STT provider/);
  });
});
