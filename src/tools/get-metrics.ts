import { z } from "zod";
import type { PatterServer } from "../patter-server.js";

export const getMetricsSchema = z.object({
  callId: z.string().describe("Call id to fetch cost + latency metrics for."),
});
export type GetMetricsInput = z.infer<typeof getMetricsSchema>;

export const getMetricsOutputSchema = z.object({
  callId: z.string(),
  outcome: z.string().optional(),
  status: z.string().optional(),
  durationSeconds: z.number().optional(),
  costUsd: z.number().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

/** Return the recorded cost + latency metrics for a single call (read-only). */
export function getMetricsHandler(args: GetMetricsInput, patter: PatterServer, userId?: string) {
  const record = patter.getCallForUser(args.callId, userId);
  if (!record) {
    return {
      content: [{ type: "text" as const, text: `No call found with id ${args.callId}.` }],
      isError: true,
    };
  }

  const metrics = record.metrics as Record<string, unknown> | undefined;
  const costUsd = (metrics?.cost as { total?: number } | undefined)?.total;

  const lines = [
    `Metrics for call ${record.callId}:`,
    `  Outcome: ${record.outcome ?? "unknown"} (${record.status})`,
    `  Duration: ${record.duration ?? 0}s`,
    costUsd !== undefined ? `  Cost: $${costUsd.toFixed(4)}` : `  Cost: (not recorded)`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: {
      callId: record.callId,
      outcome: record.outcome,
      status: record.status,
      durationSeconds: record.duration,
      costUsd,
      metrics,
    },
  };
}
