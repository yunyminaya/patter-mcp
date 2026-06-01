import { z } from "zod";
import type { PatterServer } from "../patter-server.js";
import {
  ENGINE_MODES,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  LLM_PROVIDERS,
  type AgentConfigInput,
} from "../agent-config.js";

export const configureInboundSchema = z.object({
  systemPrompt: z
    .string()
    .describe("Instructions for the AI agent that answers incoming calls on this number."),
  firstMessage: z.string().optional().describe("Greeting spoken when an inbound call is answered."),
  engineMode: z.enum(ENGINE_MODES).optional().describe("Voice engine (default 'pipeline')."),
  sttProvider: z.enum(STT_PROVIDERS).optional().describe("Speech-to-text provider (pipeline mode)."),
  llmProvider: z.enum(LLM_PROVIDERS).optional().describe("LLM provider (pipeline mode)."),
  ttsProvider: z.enum(TTS_PROVIDERS).optional().describe("Text-to-speech provider (pipeline mode)."),
  voice: z.string().optional().describe("Voice name/id for the chosen TTS or engine."),
  language: z.string().optional().describe("BCP-47 language code, e.g. 'en', 'it'."),
});
export type ConfigureInboundInput = z.infer<typeof configureInboundSchema>;

export const configureInboundOutputSchema = z.object({
  status: z.string(),
  phoneNumber: z.string(),
  engineMode: z.string(),
});

/**
 * Configure the inbound agent and (re)start the server so incoming calls to the
 * Patter number are answered with it. This is server-startup config: it changes
 * the default that answers ALL future inbound calls (not a single live call).
 */
export async function configureInboundHandler(args: ConfigureInboundInput, patter: PatterServer) {
  try {
    const config: AgentConfigInput = { ...args };
    await patter.reconfigureInbound(config);
    const engineMode = args.engineMode ?? "pipeline";
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Inbound agent configured on ${patter.phoneNumber}. ` +
            `Incoming calls are answered with engine '${engineMode}'.`,
        },
      ],
      structuredContent: { status: "configured", phoneNumber: patter.phoneNumber, engineMode },
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to configure inbound agent: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
