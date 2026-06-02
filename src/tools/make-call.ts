import { z } from "zod";
import type { PatterServer, MakeCallOptions, CallRecord } from "../patter-server.js";
import {
  resolveAgentConfig,
  ENGINE_MODES,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  LLM_PROVIDERS,
  type AgentConfigInput,
} from "../agent-config.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const guardrailSchema = z.object({
  name: z.string().describe("Identifier for logging when the guardrail trips."),
  blockedTerms: z
    .array(z.string())
    .optional()
    .describe("Case-insensitive terms that block the agent's response."),
  replacement: z.string().optional().describe("What the agent says instead when blocked."),
});

const webhookToolSchema = z.object({
  name: z.string().describe("Tool name the agent sees."),
  description: z.string().optional().describe("What the tool does (shown to the agent)."),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema for the tool's arguments."),
  webhookUrl: z.string().url().describe("URL POSTed to when the agent calls this tool."),
});

const mcpServerSchema = z.union([
  z.string().describe("MCP server URL (streamable-http)."),
  z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    name: z.string().optional(),
  }),
]);

export const makeCallSchema = z.object({
  to: z.string().describe("Phone number to call in E.164 format (e.g. +15551234567)."),
  systemPrompt: z.string().describe("Instructions for the AI voice agent on the call."),
  firstMessage: z.string().optional().describe("Opening message when the callee answers."),

  // --- Pipeline / engine selection ---
  engineMode: z
    .enum(ENGINE_MODES)
    .optional()
    .describe(
      "Voice engine. 'pipeline' (STT->LLM->TTS, default) lets you pick providers; " +
        "'openai_realtime' / 'openai_realtime_2' / 'elevenlabs_convai' are speech-to-speech.",
    ),
  sttProvider: z.enum(STT_PROVIDERS).optional().describe("Speech-to-text provider (pipeline mode)."),
  llmProvider: z.enum(LLM_PROVIDERS).optional().describe("LLM provider (pipeline mode)."),
  ttsProvider: z.enum(TTS_PROVIDERS).optional().describe("Text-to-speech provider (pipeline mode)."),
  voice: z.string().optional().describe("Voice name/id for the chosen TTS or engine."),
  language: z.string().optional().describe("BCP-47 language code, e.g. 'en', 'it'."),

  // --- Call control ---
  machineDetection: z.boolean().optional().describe("Enable answering-machine detection (default true)."),
  voicemailMessage: z.string().optional().describe("Message to leave if the call reaches voicemail."),
  ringTimeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Seconds to ring before giving up (default 25)."),

  // --- Tools / guardrails / MCP ---
  guardrails: z.array(guardrailSchema).optional().describe("Declarative response guardrails."),
  tools: z
    .array(webhookToolSchema)
    .optional()
    .describe("Webhook-backed function tools the agent can call mid-call."),
  mcpServers: z
    .array(mcpServerSchema)
    .optional()
    .describe("External MCP servers whose tools the agent inherits."),

  // --- Safety ---
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Validate the configuration + estimate cost and return the plan WITHOUT placing a real call.",
    ),
});

export type MakeCallInput = z.infer<typeof makeCallSchema>;

export const makeCallOutputSchema = z.object({
  status: z.string().describe("'completed' | 'ended' | 'failed' | 'planned' (dry run)."),
  dryRun: z.boolean().optional(),
  callId: z.string().optional(),
  outcome: z.string().optional(),
  durationSeconds: z.number().optional(),
  costUsd: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
  transcriptUri: z.string().optional(),
  plan: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USD_PER_MINUTE = Number(process.env.PATTER_ESTIMATED_USD_PER_MIN ?? "0.12");
const MAX_CALL_SECONDS = Number(process.env.MAX_CALL_DURATION_SECONDS ?? "300");

/** Conservative upper-bound cost estimate (worst case = full max-duration call). */
export function estimateCallCostUsd(): number {
  return Math.round((MAX_CALL_SECONDS / 60) * USD_PER_MINUTE * 1000) / 1000;
}

/** Pick the agent-config subset out of the tool args. */
function toAgentConfig(args: MakeCallInput): AgentConfigInput {
  return {
    systemPrompt: args.systemPrompt,
    firstMessage: args.firstMessage,
    voice: args.voice,
    language: args.language,
    engineMode: args.engineMode,
    sttProvider: args.sttProvider,
    llmProvider: args.llmProvider,
    ttsProvider: args.ttsProvider,
    guardrails: args.guardrails,
    tools: args.tools,
    mcpServers: args.mcpServers,
  };
}

function formatTranscript(transcript: Array<{ role: string; text: string }>): string {
  if (!transcript.length) return "(no transcript)";
  return transcript.map((t) => `[${t.role}] ${t.text}`).join("\n");
}

/**
 * Validate the call configuration (resolving providers surfaces missing API
 * keys / bad provider names) and return the resolved plan + a cost estimate,
 * WITHOUT placing a call. Throws on invalid configuration.
 */
export function planCall(args: MakeCallInput): {
  plan: Record<string, unknown>;
  estimatedCostUsd: number;
} {
  // Resolve to validate provider names + required env keys; instances discarded.
  resolveAgentConfig(toAgentConfig(args));

  const mode = args.engineMode ?? "pipeline";
  const plan: Record<string, unknown> = {
    to: args.to,
    engineMode: mode,
    voice: args.voice,
    language: args.language,
    machineDetection: args.machineDetection ?? true,
    ringTimeout: args.ringTimeout ?? 25,
    tools: args.tools?.map((t) => t.name) ?? [],
    guardrails: args.guardrails?.map((g) => g.name) ?? [],
    mcpServers: args.mcpServers?.length ?? 0,
  };
  if (mode === "pipeline") {
    plan.sttProvider = args.sttProvider ?? "deepgram";
    plan.ttsProvider = args.ttsProvider ?? "elevenlabs";
    plan.llmProvider = args.llmProvider ?? "(sdk default)";
  }

  return { plan, estimatedCostUsd: estimateCallCostUsd() };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function makeCallHandler(args: MakeCallInput, patter: PatterServer, userId?: string) {
  try {
    const options: MakeCallOptions = {
      ...toAgentConfig(args),
      to: args.to,
      machineDetection: args.machineDetection,
      voicemailMessage: args.voicemailMessage,
      ringTimeout: args.ringTimeout,
      userId,
    };

    // makeCall blocks until the call reaches a terminal state (the SDK's
    // call({ wait: true }) primitive) and returns the mapped CallRecord.
    const record: CallRecord = await patter.makeCall(options);

    const costUsd = (record.metrics as { cost?: { total?: number } } | undefined)?.cost?.total;
    const structured = {
      status: record.status,
      callId: record.callId,
      outcome: record.outcome ?? "unknown",
      durationSeconds: record.duration ?? 0,
      costUsd,
      transcriptUri: `patter://call/${record.callId}/transcript`,
    };

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Call to ${args.to} ${record.status === "completed" ? "completed" : "ended"}.\n\n` +
            `Call ID: ${record.callId}\n` +
            `Outcome: ${record.outcome ?? "unknown"}\n` +
            `Status: ${record.status}\n` +
            `Duration: ${record.duration ?? 0}s\n` +
            (costUsd !== undefined ? `Cost: $${costUsd.toFixed(4)}\n` : "") +
            `\nTranscript:\n${formatTranscript(record.transcript)}`,
        },
      ],
      structuredContent: structured,
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to place call: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
