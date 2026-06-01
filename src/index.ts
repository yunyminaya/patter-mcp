/**
 * Patter MCP Server — mcp-use transport
 *
 * Uses MCPServer from mcp-use/server for session management, transport,
 * and the built-in inspector UI. Claude Code connects with:
 *
 *   claude mcp add --transport http patter-mcp http://localhost:3000/mcp
 */

import { z } from "zod";
import { MCPServer, oauthAuth0Provider } from "mcp-use/server";

import { createPatter, getPatter, maybeEagerBoot, isPatterBooting } from "./patter-lifecycle.js";
import {
  makeCallHandler,
  makeCallSchema,
  makeCallOutputSchema,
  planCall,
  estimateCallCostUsd,
  type MakeCallInput,
} from "./tools/make-call.js";
import { callThirdPartyHandler, callThirdPartySchema, type CallThirdPartyInput } from "./tools/call-third-party.js";
import { getCallsHandler } from "./tools/get-calls.js";
import { getTranscriptHandler, getTranscriptSchema, type GetTranscriptInput } from "./tools/get-transcript.js";
import { endCallHandler, endCallSchema, endCallOutputSchema, type EndCallInput } from "./tools/end-call.js";
import {
  getMetricsHandler,
  getMetricsSchema,
  getMetricsOutputSchema,
  type GetMetricsInput,
} from "./tools/get-metrics.js";
import {
  configureInboundHandler,
  configureInboundSchema,
  configureInboundOutputSchema,
  type ConfigureInboundInput,
} from "./tools/configure-inbound.js";
import { validatePhoneNumber } from "./phone-validation.js";
import { checkRateLimit, recordCallStart } from "./rate-limiter.js";
import { registerCallDashboard } from "./resources/call-dashboard.js";
import { registerCallResources } from "./resources/call-resources.js";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3000", 10);
const PATTER_PORT = parseInt(process.env.PATTER_PORT ?? "8000", 10);

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
}

/** Build a uniform MCP error response from a plain message string. */
function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Extract the userId from the MCP request context, guarding against empty
 * strings that could slip through as "authenticated" user identifiers.
 * Returns `undefined` when auth is disabled or the userId is blank.
 */
function extractUserId(ctx: { auth?: { user: { userId: string } } }): string | undefined {
  const raw = ctx.auth?.user.userId;
  return raw?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Shared Patter server instance
// ---------------------------------------------------------------------------

const patter = (() => {
  try {
    return createPatter();
  } catch (err) {
    log(`Failed to initialize Patter: ${err instanceof Error ? err.message : String(err)}`);
    log("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OPENAI_API_KEY");
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// MCP server with mcp-use
// ---------------------------------------------------------------------------

// OAuth is optional: when AUTH0_DOMAIN + AUTH0_AUDIENCE are set, all /mcp
// endpoints require a valid Bearer token. When absent the server runs in
// unauthenticated mode so local dev works without any auth configuration.
const oauthConfig =
  process.env.AUTH0_DOMAIN && process.env.AUTH0_AUDIENCE
    ? oauthAuth0Provider({
        domain: process.env.AUTH0_DOMAIN,
        audience: process.env.AUTH0_AUDIENCE,
      })
    : undefined;

const server = new MCPServer({
  name: "patter-mcp",
  version: "0.4.0",
  ...(oauthConfig !== undefined ? { oauth: oauthConfig } : {}),
});

// -- make_call
server.tool(
  {
    name: "make_call",
    description:
      "Place a REAL outbound phone call with an AI voice agent. Dials a real " +
      "number and COSTS MONEY. Configure the engine/providers (engineMode, " +
      "stt/llm/ttsProvider, voice, language), attach webhook tools or MCP " +
      "servers, or set dryRun:true to validate the config + estimate cost " +
      "WITHOUT dialing. Blocks until the call ends, then returns outcome " +
      "(answered / voicemail / no_answer / busy / failed), duration, cost, and " +
      "transcript.",
    schema: makeCallSchema,
    outputSchema: makeCallOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args: MakeCallInput, ctx) => {
    const userId = extractUserId(ctx);

    const phoneResult = validatePhoneNumber(args.to);
    if (!phoneResult.valid) {
      return errorResponse(phoneResult.error);
    }
    const validatedArgs: MakeCallInput = { ...args, to: phoneResult.e164 };

    // Dry run: validate providers/keys + estimate cost. No dial, no rate charge.
    if (args.dryRun) {
      try {
        const { plan, estimatedCostUsd } = planCall(validatedArgs);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Dry run — would place a call to ${plan.to}.\n` +
                `Estimated max cost: ~$${estimatedCostUsd.toFixed(4)}\n` +
                `Plan:\n${JSON.stringify(plan, null, 2)}`,
            },
          ],
          structuredContent: { status: "planned", dryRun: true, estimatedCostUsd, plan },
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    }

    const rateResult = checkRateLimit(userId);
    if (!rateResult.allowed) {
      return errorResponse(rateResult.reason ?? "Rate limit exceeded.");
    }

    // Optional human-in-the-loop confirmation for the billable action. Off by
    // default; enable with PATTER_CONFIRM_CALLS=1 (requires a client that
    // supports MCP elicitation).
    if (process.env.PATTER_CONFIRM_CALLS === "1") {
      const ictx = ctx as unknown as {
        elicit?: (
          message: string,
          schema: unknown,
        ) => Promise<{ action: string; data?: Record<string, unknown> }>;
        client?: { can?: (cap: string) => boolean };
      };
      if (ictx.elicit && ictx.client?.can?.("elicitation")) {
        const est = estimateCallCostUsd();
        const reply = await ictx.elicit(
          `Place a real call to ${validatedArgs.to}? (~$${est.toFixed(4)} max)`,
          z.object({ confirm: z.boolean().describe("true to place the call") }),
        );
        if (reply.action !== "accept" || reply.data?.confirm !== true) {
          return {
            content: [
              { type: "text" as const, text: "Call cancelled — confirmation not granted." },
            ],
            structuredContent: { status: "cancelled" },
          };
        }
      }
    }

    recordCallStart(userId);
    await getPatter(); // lazy boot at first tool call
    return makeCallHandler(validatedArgs, patter, userId);
  },
);

// -- call_third_party
server.tool(
  {
    name: "call_third_party",
    description:
      "Call a third party (restaurant, business, person) with a specific task. " +
      "Places a REAL call that COSTS MONEY. An autonomous AI agent handles the " +
      "conversation, waits for it to complete, and returns the full transcript.",
    schema: callThirdPartySchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args: CallThirdPartyInput, ctx) => {
    const userId = extractUserId(ctx);

    const phoneResult = validatePhoneNumber(args.to);
    if (!phoneResult.valid) {
      return errorResponse(phoneResult.error);
    }

    const rateResult = checkRateLimit(userId);
    if (!rateResult.allowed) {
      return errorResponse(rateResult.reason ?? "Rate limit exceeded.");
    }

    recordCallStart(userId);

    // Replace raw input with the validated E.164 number
    const validatedArgs: CallThirdPartyInput = { ...args, to: phoneResult.e164 };
    await getPatter(); // lazy boot at first tool call
    return callThirdPartyHandler(validatedArgs, patter, userId);
  },
);

// -- get_calls
server.tool(
  {
    name: "get_calls",
    description: "List all recent calls with their status, duration, cost, and turn count.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (_args, ctx) => {
    const userId = extractUserId(ctx);
    await getPatter(); // lazy boot at first tool call
    return getCallsHandler(patter, userId);
  },
);

// -- get_transcript
server.tool(
  {
    name: "get_transcript",
    description: "Get the full conversation transcript of a completed call.",
    schema: getTranscriptSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args: GetTranscriptInput, ctx) => {
    const userId = extractUserId(ctx);
    await getPatter(); // lazy boot at first tool call
    return getTranscriptHandler(args, patter, userId);
  },
);

// -- end_call
server.tool(
  {
    name: "end_call",
    description:
      "Hang up a live call by its carrier call id (also serves to reject an " +
      "inbound call). Safe to call on an already-ended call.",
    schema: endCallSchema,
    outputSchema: endCallOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async (args: EndCallInput) => {
    await getPatter(); // ensure the server is up so the carrier control plane is reachable
    return endCallHandler(args, patter);
  },
);

// -- get_metrics
server.tool(
  {
    name: "get_metrics",
    description:
      "Get the recorded cost + latency metrics (and outcome/duration) for a " +
      "single call. Read-only; does not place or boot anything.",
    schema: getMetricsSchema,
    outputSchema: getMetricsOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args: GetMetricsInput, ctx) => {
    const userId = extractUserId(ctx);
    return getMetricsHandler(args, patter, userId);
  },
);

// -- configure_inbound
server.tool(
  {
    name: "configure_inbound",
    description:
      "Configure the AI agent that ANSWERS incoming calls to your Patter " +
      "number, and (re)start the server so it takes effect. Sets the default " +
      "for ALL future inbound calls (not a single live call). Choose the " +
      "engine/providers, voice and language. Restarting may briefly change the " +
      "webhook tunnel URL.",
    schema: configureInboundSchema,
    outputSchema: configureInboundOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args: ConfigureInboundInput) => {
    return configureInboundHandler(args, patter);
  },
);

// ---------------------------------------------------------------------------
// Call dashboard resources + MCP Apps widget
// ---------------------------------------------------------------------------

registerCallDashboard(server, patter);
registerCallResources(server, patter);

// Bridge inbound lifecycle events (incoming_call / call_ended) to MCP
// notifications, and nudge subscribers of the active-calls resource.
patter.setNotifier((method, params) => {
  try {
    void Promise.resolve(server.sendNotification(method, params)).catch(() => {});
    void Promise.resolve(server.notifyResourceUpdated("patter://calls/active")).catch(() => {});
  } catch {
    /* notifications are best-effort */
  }
});

// ---------------------------------------------------------------------------
// Custom HTTP routes via Hono app
// ---------------------------------------------------------------------------

// Health check
server.app.get("/health", (c) =>
  c.json({
    status: "ok",
    mode: "mcp",
    phone: patter.phoneNumber,
    serverRunning: patter.isServerRunning,
    activeSessions: server.sessions.size,
  }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await maybeEagerBoot();

  // Start MCP HTTP server (inspector auto-available at /inspector)
  await server.listen(MCP_PORT);

  log(`
██████╗  █████╗ ████████╗████████╗███████╗██████╗
██╔══██╗██╔══██╗╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
██████╔╝███████║   ██║      ██║   █████╗  ██████╔╝
██╔═══╝ ██╔══██║   ██║      ██║   ██╔══╝  ██╔══██╗
██║     ██║  ██║   ██║      ██║   ███████╗██║  ██║
╚═╝     ╚═╝  ╚═╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

Patter MCP Server
`);
  log(`MCP endpoint:  http://localhost:${MCP_PORT}/mcp`);
  log(`Inspector:     http://localhost:${MCP_PORT}/inspector`);
  log(`Patter server: http://localhost:${PATTER_PORT}/`);
  log(`Phone number:  ${patter.phoneNumber}`);
  log(`Health check:  http://localhost:${MCP_PORT}/health`);
  log(``);
  log(`Connect Claude Code:`);
  log(`  claude mcp add --transport http patter-mcp http://localhost:${MCP_PORT}/mcp`);
  log(``);
  log(`Tools: make_call, call_third_party, get_calls, get_transcript`);
  log(`Resources: patter://dashboard, patter://call/{callId}`);
  log(`Widget: call-dashboard-widget (MCP Apps / ChatGPT)`);
  log(`Voice tools (during calls): read_file, run_command, search_code`);
  log(`Auth: ${oauthConfig ? `Auth0 (${process.env.AUTH0_DOMAIN})` : "disabled (no AUTH0_DOMAIN)"}`);
  log(`Lifecycle: ${process.env.PATTER_EAGER === "1" ? "eager" : "lazy (boot on first tool call)"}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

/**
 * Tear the embedded Patter server down on process termination.
 *
 * Only acts when the server was actually booted (lazy mode boots on the first
 * tool call), using the same memoized instance via getPatter(). disconnect()
 * stops the HTTP server, closes the cloudflared tunnel, drops any pending
 * `call({ wait: true })` awaiters, and clears prewarm/TTS work — without it
 * the tunnel and WebSocket server are abandoned on exit.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal} — shutting down...`);
  try {
    if (isPatterBooting()) {
      const p = await getPatter();
      await p.disconnect();
      log("Patter server disconnected cleanly");
    }
  } catch (err) {
    log(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
