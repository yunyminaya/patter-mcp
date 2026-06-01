/**
 * Read-only MCP resources for call data + the provider catalog.
 *
 * These complement the human-facing `patter://dashboard` (Markdown) and the
 * `call-dashboard-widget` (MCP Apps) registered in call-dashboard.ts. Here we
 * expose token-cheap, machine-readable JSON the agent can pull on demand:
 *
 *   - patter://calls                      → recent calls (list)
 *   - patter://call/{callId}/transcript   → one call's transcript
 *   - patter://call/{callId}/metrics      → one call's cost + latency
 *   - patter://providers                  → valid engine/provider names
 *
 * Modelling reads as resources (not tools) follows MCP guidance: the host
 * decides when to load them, and the agent isn't tempted to "call" a read.
 */

import type { McpServerInstance } from "mcp-use/server";

import type { PatterServer, CallRecord } from "../patter-server.js";
import { PROVIDER_CATALOG } from "../agent-config.js";

function jsonContents(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  };
}

/** Compact, list-friendly projection of a call record. */
function summarizeCall(call: CallRecord): Record<string, unknown> {
  const cost = (call.metrics as { cost?: { total?: number } } | undefined)?.cost?.total;
  return {
    callId: call.callId,
    direction: call.direction,
    to: call.to,
    from: call.from,
    status: call.status,
    outcome: call.outcome,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    duration: call.duration,
    costUsd: cost,
  };
}

export function registerCallResources(server: McpServerInstance, patter: PatterServer): void {
  // patter://calls — recent call list (JSON)
  server.resource(
    {
      name: "calls",
      uri: "patter://calls",
      title: "Recent Calls",
      description: "Recent calls with status, direction, duration and cost (JSON list).",
      mimeType: "application/json",
    },
    async () => {
      const calls = patter.getCallsForUser(undefined);
      return jsonContents("patter://calls", Array.from(calls.values()).map(summarizeCall));
    },
  );

  // patter://calls/active — currently ringing / in-progress calls (subscribable)
  server.resource(
    {
      name: "active-calls",
      uri: "patter://calls/active",
      title: "Active Calls",
      description:
        "Calls currently ringing or in progress (JSON). Subscribe for live updates; " +
        "the server emits resource-updated notifications as inbound calls start and end.",
      mimeType: "application/json",
    },
    async () => {
      const calls = patter.getCallsForUser(undefined);
      const active = Array.from(calls.values())
        .filter((c) => c.status === "ringing" || c.status === "in-progress")
        .map(summarizeCall);
      return jsonContents("patter://calls/active", active);
    },
  );

  // patter://call/{callId}/transcript — one call's transcript (JSON)
  server.resourceTemplate(
    {
      name: "call-transcript",
      uriTemplate: "patter://call/{callId}/transcript",
      title: "Call Transcript",
      description: "The conversation transcript of a single call (JSON array of {role,text}).",
      mimeType: "application/json",
    },
    async (uri: URL, params: Record<string, string>) => {
      const call = patter.getCallForUser(params.callId ?? "", undefined);
      return jsonContents(
        uri.toString(),
        call ? call.transcript : { error: `No call with id ${params.callId}` },
      );
    },
  );

  // patter://call/{callId}/metrics — one call's cost + latency (JSON)
  server.resourceTemplate(
    {
      name: "call-metrics",
      uriTemplate: "patter://call/{callId}/metrics",
      title: "Call Metrics",
      description: "Cost + latency metrics, outcome and duration for a single call (JSON).",
      mimeType: "application/json",
    },
    async (uri: URL, params: Record<string, string>) => {
      const call = patter.getCallForUser(params.callId ?? "", undefined);
      return jsonContents(
        uri.toString(),
        call
          ? {
              callId: call.callId,
              outcome: call.outcome,
              status: call.status,
              duration: call.duration,
              metrics: call.metrics ?? null,
            }
          : { error: `No call with id ${params.callId}` },
      );
    },
  );

  // patter://providers — valid engine/provider names for make_call / configure_inbound
  server.resource(
    {
      name: "providers",
      uri: "patter://providers",
      title: "Provider Catalog",
      description:
        "Valid engine modes and STT/TTS/LLM provider names accepted by make_call and configure_inbound.",
      mimeType: "application/json",
    },
    async () => jsonContents("patter://providers", PROVIDER_CATALOG),
  );
}
