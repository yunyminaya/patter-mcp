import { z } from "zod";
import type { PatterServer } from "../patter-server.js";

export const endCallSchema = z.object({
  callId: z.string().describe("Carrier call id of the live call to hang up."),
});
export type EndCallInput = z.infer<typeof endCallSchema>;

export const endCallOutputSchema = z.object({
  callId: z.string(),
  status: z.string(),
});

/** Hang up a live call. Idempotent at the carrier level (ending an already-ended call is a no-op). */
export async function endCallHandler(args: EndCallInput, patter: PatterServer) {
  try {
    await patter.endCall(args.callId);
    return {
      content: [
        { type: "text" as const, text: `Hang-up requested for call ${args.callId}.` },
      ],
      structuredContent: { callId: args.callId, status: "hangup_requested" },
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to end call ${args.callId}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
