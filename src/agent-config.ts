/**
 * Agent configuration resolver.
 *
 * Maps the string-based pipeline parameters that arrive over MCP (engine mode,
 * STT/LLM/TTS provider names, voice, language, declarative guardrails, webhook
 * tools, MCP servers) onto the getpatter SDK's typed `AgentOptions`. This is the
 * shared foundation behind both the outbound `make_call` tool and the inbound
 * `configure_inbound` tool — they differ only in lifetime (per-call vs
 * server-startup), not in how the agent is built.
 *
 * Only JSON-serialisable configuration crosses the MCP boundary: provider
 * choices, voices, declarative guardrails (term lists), and **webhook** tools.
 * In-process tool handlers, pipeline hooks, and text transforms are code-only
 * and cannot be expressed over MCP — see PROVIDER_CATALOG for the exposable set.
 */

import {
  // STT
  DeepgramSTT,
  WhisperSTT,
  OpenAITranscribeSTT,
  CartesiaSTT,
  SonioxSTT,
  AssemblyAISTT,
  SpeechmaticsSTT,
  // TTS
  ElevenLabsTTS,
  OpenAITTS,
  CartesiaTTS,
  RimeTTS,
  LMNTTTS,
  InworldTTS,
  // LLM
  OpenAILLM,
  AnthropicLLM,
  GroqLLM,
  GoogleLLM,
  CerebrasLLM,
  // Engines (speech-to-speech)
  OpenAIRealtime,
  OpenAIRealtime2,
  ElevenLabsConvAI,
  // Primitives
  Tool,
  Guardrail,
  type AgentOptions,
} from "getpatter";

// ---------------------------------------------------------------------------
// Catalog — the valid, MCP-exposable provider/engine names (single source of
// truth for both validation here and the `patter://providers` resource).
// ---------------------------------------------------------------------------

export const ENGINE_MODES = [
  "pipeline",
  "openai_realtime",
  "openai_realtime_2",
  "elevenlabs_convai",
] as const;
export type EngineMode = (typeof ENGINE_MODES)[number];

export const STT_PROVIDERS = [
  "deepgram",
  "whisper",
  "openai",
  "cartesia",
  "soniox",
  "assemblyai",
  "speechmatics",
] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];

export const TTS_PROVIDERS = [
  "elevenlabs",
  "openai",
  "cartesia",
  "rime",
  "lmnt",
  "inworld",
] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "groq",
  "google",
  "cerebras",
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Machine-readable catalog surfaced via the `patter://providers` resource. */
export const PROVIDER_CATALOG = {
  engineModes: ENGINE_MODES,
  stt: STT_PROVIDERS,
  tts: TTS_PROVIDERS,
  llm: LLM_PROVIDERS,
} as const;

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/** A declarative, JSON-serialisable guardrail (no in-process `check` fn). */
export interface GuardrailInput {
  readonly name: string;
  readonly blockedTerms?: string[];
  readonly replacement?: string;
}

/** A webhook-backed function tool (the only tool form expressible over MCP). */
export interface WebhookToolInput {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly webhookUrl: string;
}

/** MCP server attachable to the voice agent (string URL or detailed config). */
export type McpServerInput =
  | string
  | { readonly url: string; readonly headers?: Record<string, string>; readonly name?: string };

/** The string-based agent configuration that arrives over MCP. */
export interface AgentConfigInput {
  readonly systemPrompt: string;
  readonly firstMessage?: string;
  readonly voice?: string;
  readonly language?: string;
  readonly engineMode?: EngineMode;
  readonly sttProvider?: SttProvider;
  readonly llmProvider?: LlmProvider;
  readonly ttsProvider?: TtsProvider;
  readonly guardrails?: ReadonlyArray<GuardrailInput>;
  readonly tools?: ReadonlyArray<WebhookToolInput>;
  readonly mcpServers?: ReadonlyArray<McpServerInput>;
}

// ---------------------------------------------------------------------------
// Provider construction (each class reads its API key from env and throws a
// clear error when the key is missing — we surface that to the MCP caller).
// ---------------------------------------------------------------------------

function listOf(values: ReadonlyArray<string>): string {
  return values.join(", ");
}

function buildStt(name: SttProvider, language?: string) {
  switch (name) {
    case "deepgram":
      return new DeepgramSTT(language ? { language } : {});
    case "whisper":
      return new WhisperSTT();
    case "openai":
      return new OpenAITranscribeSTT();
    case "cartesia":
      return new CartesiaSTT();
    case "soniox":
      return new SonioxSTT();
    case "assemblyai":
      return new AssemblyAISTT();
    case "speechmatics":
      return new SpeechmaticsSTT();
    default:
      throw new Error(`Unknown STT provider "${name}". Valid: ${listOf(STT_PROVIDERS)}.`);
  }
}

function buildTts(name: TtsProvider, voice?: string) {
  switch (name) {
    case "elevenlabs":
      // ElevenLabs is the default pipeline TTS; wire `voice` to its voiceId to
      // preserve the existing behaviour. Other providers use the agent-level
      // `voice` field instead.
      return new ElevenLabsTTS(voice ? { voiceId: voice } : {});
    case "openai":
      return new OpenAITTS();
    case "cartesia":
      return new CartesiaTTS();
    case "rime":
      return new RimeTTS();
    case "lmnt":
      return new LMNTTTS();
    case "inworld":
      return new InworldTTS();
    default:
      throw new Error(`Unknown TTS provider "${name}". Valid: ${listOf(TTS_PROVIDERS)}.`);
  }
}

function buildLlm(name: LlmProvider) {
  switch (name) {
    case "openai":
      return new OpenAILLM();
    case "anthropic":
      return new AnthropicLLM();
    case "groq":
      return new GroqLLM();
    case "google":
      return new GoogleLLM();
    case "cerebras":
      return new CerebrasLLM();
    default:
      throw new Error(`Unknown LLM provider "${name}". Valid: ${listOf(LLM_PROVIDERS)}.`);
  }
}

function buildEngine(mode: EngineMode, voice?: string) {
  const opts = voice ? { voice } : {};
  switch (mode) {
    case "openai_realtime":
      return new OpenAIRealtime(opts);
    case "openai_realtime_2":
      return new OpenAIRealtime2(opts);
    case "elevenlabs_convai":
      return new ElevenLabsConvAI(opts);
    case "pipeline":
      return undefined; // pipeline mode uses stt/llm/tts, not an engine
    default:
      throw new Error(`Unknown engine mode "${mode}". Valid: ${listOf(ENGINE_MODES)}.`);
  }
}

function buildGuardrails(inputs: ReadonlyArray<GuardrailInput>): Guardrail[] {
  return inputs.map(
    (g) =>
      new Guardrail({
        name: g.name,
        blockedTerms: g.blockedTerms,
        replacement: g.replacement,
      }),
  );
}

function buildTools(inputs: ReadonlyArray<WebhookToolInput>): Tool[] {
  return inputs.map(
    (t) =>
      new Tool({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        webhookUrl: t.webhookUrl,
      }),
  );
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve string-based MCP parameters into the SDK's `AgentOptions`.
 *
 * Defaults (matching the historical inbound/outbound behaviour) are pipeline
 * mode with Deepgram STT + ElevenLabs TTS and the SDK's default LLM. Selecting
 * a realtime/ConvAI `engineMode` switches to speech-to-speech and ignores the
 * pipeline provider fields.
 *
 * @throws Error with a clear message when a provider name is invalid or a
 *   required provider API key is missing in the environment.
 */
export function resolveAgentConfig(input: AgentConfigInput): AgentOptions {
  const mode: EngineMode = input.engineMode ?? "pipeline";

  const base: AgentOptions = {
    systemPrompt: input.systemPrompt,
    firstMessage: input.firstMessage,
    voice: input.voice,
    language: input.language,
  };

  if (input.guardrails?.length) base.guardrails = buildGuardrails(input.guardrails);
  if (input.tools?.length) base.tools = buildTools(input.tools);
  if (input.mcpServers?.length) base.mcpServers = [...input.mcpServers];

  if (mode === "pipeline") {
    base.stt = buildStt(input.sttProvider ?? "deepgram", input.language);
    base.tts = buildTts(input.ttsProvider ?? "elevenlabs", input.voice);
    if (input.llmProvider) base.llm = buildLlm(input.llmProvider);
  } else {
    base.engine = buildEngine(mode, input.voice);
  }

  return base;
}
