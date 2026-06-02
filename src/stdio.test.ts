/**
 * stdio transport smoke test.
 *
 * Spawns the REAL entrypoint with `--stdio`, speaks real MCP JSON-RPC over the
 * child's stdin/stdout, and asserts:
 *   1. stdout carries ONLY valid JSON-RPC frames (no banner / debug pollution),
 *      which is the hard contract for a stdio MCP transport.
 *   2. `tools/list` returns all 7 tools — proving the SAME registrations the
 *      HTTP path uses are replayed onto the stdio-connected native server via
 *      `getServerForSession()`, with zero tool definitions duplicated.
 *
 * Nothing is mocked: this exercises the real StdioServerTransport and the real
 * mcp-use registration replay. The carrier boot stays lazy (PATTER_EAGER unset
 * + no tool is invoked), so no real call is placed and the placeholder Twilio /
 * OpenAI credentials are never used to dial.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "index.ts");

const EXPECTED_TOOLS = [
  "make_call",
  "call_third_party",
  "get_calls",
  "get_transcript",
  "end_call",
  "get_metrics",
  "configure_inbound",
].sort();

interface JsonRpcFrame {
  jsonrpc: string;
  id?: number;
  result?: { tools?: Array<{ name: string }> };
}

/**
 * Drive the stdio server: write the given JSON-RPC requests (newline-delimited)
 * and collect every stdout line, resolving once a frame with `id === finalId`
 * arrives. Rejects on any non-JSON stdout line (= stdout pollution).
 */
function driveStdioServer(requests: object[], finalId: number): Promise<JsonRpcFrame[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", ENTRY, "--stdio"], {
      cwd: join(__dirname, ".."),
      env: {
        ...process.env,
        TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000000",
        TWILIO_AUTH_TOKEN: "testtoken",
        TWILIO_PHONE_NUMBER: "+15555550100",
        OPENAI_API_KEY: "sk-test-placeholder",
        PATTER_DB_PATH: ":memory:",
        PATTER_EAGER: "", // keep the carrier boot lazy — no real call
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const frames: JsonRpcFrame[] = [];
    let stdoutBuf = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      fn();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // keep the trailing partial line
      for (const line of lines) {
        if (line.trim() === "") continue;
        let frame: JsonRpcFrame;
        try {
          frame = JSON.parse(line) as JsonRpcFrame;
        } catch {
          finish(() => reject(new Error(`stdout pollution — non-JSON line: ${JSON.stringify(line)}`)));
          return;
        }
        frames.push(frame);
        if (frame.id === finalId) {
          finish(() => resolve(frames));
          return;
        }
      }
    });

    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) =>
      finish(() => reject(new Error(`child exited early (code ${code}) before id=${finalId}`))),
    );

    // mcp-use registration emits a stray console.log on resource templates; the
    // entrypoint reroutes console.* to stderr in --stdio mode. Give tsx a moment
    // to boot, then send the frames.
    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }
  });
}

describe("[integration] stdio transport", () => {
  it(
    "serves all 7 tools over stdio with a pollution-free stdout stream",
    async () => {
      const frames = await driveStdioServer(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "stdio-smoke", version: "0.0.0" },
            },
          },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ],
        2,
      );

      // Every stdout line was valid JSON-RPC (driveStdioServer rejects otherwise).
      expect(frames.every((f) => f.jsonrpc === "2.0")).toBe(true);

      const listFrame = frames.find((f) => f.id === 2);
      expect(listFrame).toBeDefined();
      const toolNames = (listFrame?.result?.tools ?? []).map((t) => t.name).sort();
      expect(toolNames).toEqual(EXPECTED_TOOLS);
    },
    30_000,
  );
});
