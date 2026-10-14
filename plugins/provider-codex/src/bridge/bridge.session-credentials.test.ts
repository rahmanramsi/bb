import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_credentials_1";
const BASE_ENV = {
  BB_THREAD_ID: THREAD_ID,
  BB_ENVIRONMENT_ID: "env_credentials",
};

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let requestLogPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-credentials-ws-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }));
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 992_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "credentials-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

const recordedRequestSchema = z.object({
  method: z.string(),
  params: z.looseObject({
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
});

function bbTokenSeenByEachTurn(): Array<string | null> {
  const requests = readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => recordedRequestSchema.parse(JSON.parse(line)));
  let shellToken: string | null = null;
  const tokens: Array<string | null> = [];
  for (const request of requests) {
    if (
      request.method === "thread/start" ||
      request.method === "thread/resume"
    ) {
      const value = request.params.config?.["shell_environment_policy.set.BB_TOKEN"];
      shellToken = typeof value === "string" ? value : null;
    }
    if (request.method === "turn/start") {
      tokens.push(shellToken);
    }
  }
  return tokens;
}

async function startThread(envVars: Record<string, string>): Promise<string> {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS, envVars },
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();
  return z.object({ providerThreadId: z.string() }).parse(started.result)
    .providerThreadId;
}

async function runTurn(args: {
  envVars: Record<string, string>;
  id: number;
  providerThreadId: string;
}): Promise<void> {
  harness.sendRequest(args.id, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: args.providerThreadId,
    clientRequestId: `creq_credturnx${args.id}`,
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: { ...FULL_ACCESS_SESSION_OPTIONS, envVars: args.envVars },
  });
  expect((await harness.waitForResponse(args.id)).error).toBeUndefined();
}

it("rebuilds the session when a later turn removes or replaces BB_TOKEN", async () => {
  const tokenA = { ...BASE_ENV, BB_TOKEN: "token-a" };
  const providerThreadId = await startThread(tokenA);

  await runTurn({ id: 2, providerThreadId, envVars: tokenA });
  await runTurn({ id: 3, providerThreadId, envVars: BASE_ENV });
  await runTurn({
    id: 4,
    providerThreadId,
    envVars: { ...BASE_ENV, BB_TOKEN: "token-b" },
  });

  expect(bbTokenSeenByEachTurn()).toEqual(["token-a", null, "token-b"]);
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toHaveLength(2);
}, 30_000);

it("keeps the warm session for consecutive turns with the same BB_TOKEN", async () => {
  const tokenA = { ...BASE_ENV, BB_TOKEN: "token-a" };
  const providerThreadId = await startThread(tokenA);

  await runTurn({ id: 2, providerThreadId, envVars: tokenA });
  await runTurn({ id: 3, providerThreadId, envVars: { ...tokenA } });

  expect(bbTokenSeenByEachTurn()).toEqual(["token-a", "token-a"]);
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
  const initializeCount = readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => recordedRequestSchema.parse(JSON.parse(line)).method === "initialize")
    .length;
  expect(initializeCount).toBe(1);
}, 30_000);
