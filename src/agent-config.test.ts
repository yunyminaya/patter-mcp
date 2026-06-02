/**
 * Tests for the agent-config resolver: string MCP params -> SDK AgentOptions.
 *
 * Provider classes read their API key from env and throw when it is missing, so
 * we set fake keys before importing. We assert the resolved SHAPE (which engine
 * / providers / primitives are wired), not live behaviour.
 */

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.DEEPGRAM_API_KEY = "test-dg";
  process.env.ELEVENLABS_API_KEY = "test-el";
  process.env.ELEVENLABS_AGENT_ID = "agent_test";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});

import {
  resolveAgentConfig,
  PROVIDER_CATALOG,
  ENGINE_MODES,
} from "./agent-config.js";
import {
  DeepgramSTT,
  WhisperSTT,
  ElevenLabsTTS,
  AnthropicLLM,
  Tool,
  Guardrail,
} from "getpatter";

describe("resolveAgentConfig — pipeline mode (default)", () => {
  it("defaults to Deepgram STT + ElevenLabs TTS, no engine, no LLM", () => {
    const cfg = resolveAgentConfig({ systemPrompt: "you are helpful" });
    expect(cfg.systemPrompt).toBe("you are helpful");
    expect(cfg.engine).toBeUndefined();
    expect(cfg.stt).toBeInstanceOf(DeepgramSTT);
    expect(cfg.tts).toBeInstanceOf(ElevenLabsTTS);
    expect(cfg.llm).toBeUndefined();
  });

  it("honours an explicit STT provider", () => {
    const cfg = resolveAgentConfig({ systemPrompt: "x", sttProvider: "whisper" });
    expect(cfg.stt).toBeInstanceOf(WhisperSTT);
  });

  it("wires an LLM only when a provider is given", () => {
    const cfg = resolveAgentConfig({ systemPrompt: "x", llmProvider: "anthropic" });
    expect(cfg.llm).toBeInstanceOf(AnthropicLLM);
  });

  it("passes firstMessage, voice and language through", () => {
    const cfg = resolveAgentConfig({
      systemPrompt: "x",
      firstMessage: "hi there",
      voice: "rachel",
      language: "it",
    });
    expect(cfg.firstMessage).toBe("hi there");
    expect(cfg.voice).toBe("rachel");
    expect(cfg.language).toBe("it");
  });
});

describe("resolveAgentConfig — engine (speech-to-speech) modes", () => {
  it("openai_realtime sets an engine and no pipeline providers", () => {
    const cfg = resolveAgentConfig({ systemPrompt: "x", engineMode: "openai_realtime" });
    expect((cfg.engine as { kind: string }).kind).toBe("openai_realtime");
    expect(cfg.stt).toBeUndefined();
    expect(cfg.tts).toBeUndefined();
  });

  it("elevenlabs_convai sets a ConvAI engine", () => {
    const cfg = resolveAgentConfig({ systemPrompt: "x", engineMode: "elevenlabs_convai" });
    expect((cfg.engine as { kind: string }).kind).toBe("elevenlabs_convai");
  });
});

describe("resolveAgentConfig — declarative primitives", () => {
  it("maps declarative guardrails to Guardrail instances", () => {
    const cfg = resolveAgentConfig({
      systemPrompt: "x",
      guardrails: [{ name: "no-profanity", blockedTerms: ["damn"], replacement: "no." }],
    });
    expect(cfg.guardrails).toHaveLength(1);
    expect(cfg.guardrails![0]).toBeInstanceOf(Guardrail);
    expect(cfg.guardrails![0].name).toBe("no-profanity");
    expect(cfg.guardrails![0].blockedTerms).toEqual(["damn"]);
  });

  it("maps webhook tools to Tool instances", () => {
    const cfg = resolveAgentConfig({
      systemPrompt: "x",
      tools: [{ name: "lookup", description: "look up an order", webhookUrl: "https://x/y" }],
    });
    expect(cfg.tools).toHaveLength(1);
    expect(cfg.tools![0]).toBeInstanceOf(Tool);
    expect(cfg.tools![0].webhookUrl).toBe("https://x/y");
  });

  it("passes MCP servers through", () => {
    const cfg = resolveAgentConfig({
      systemPrompt: "x",
      mcpServers: ["https://mcp.example/mcp", { url: "https://b/mcp", name: "b" }],
    });
    expect(cfg.mcpServers).toHaveLength(2);
  });
});

describe("resolveAgentConfig — validation", () => {
  it("throws a clear error for an unknown STT provider", () => {
    expect(() =>
      resolveAgentConfig({ systemPrompt: "x", sttProvider: "bogus" as never }),
    ).toThrow(/Unknown STT provider/);
  });

  it("throws a clear error for an unknown engine mode", () => {
    expect(() =>
      resolveAgentConfig({ systemPrompt: "x", engineMode: "bogus" as never }),
    ).toThrow(/Unknown engine mode/);
  });
});

describe("PROVIDER_CATALOG", () => {
  it("exposes engine modes and provider lists", () => {
    expect(PROVIDER_CATALOG.engineModes).toEqual(ENGINE_MODES);
    expect(PROVIDER_CATALOG.stt).toContain("deepgram");
    expect(PROVIDER_CATALOG.tts).toContain("elevenlabs");
    expect(PROVIDER_CATALOG.llm).toContain("anthropic");
  });
});
