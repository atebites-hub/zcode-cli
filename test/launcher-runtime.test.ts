import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { readRuntimeVersion } from "../src/launcher.ts";

let home = "";
const node = Bun.which("node");
const root = fileURLToPath(new URL("..", import.meta.url));

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "zcode-launcher-runtime-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function run(args: string[], input = "", environment: Record<string, string> = {}) {
  if (!node) throw new Error("Node.js is required for launcher/runtime integration tests.");
  const child = Bun.spawn([process.execPath, "bin/zcode.ts", ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ZCODE_NODE: node,
      ...environment
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { code, stdout, stderr };
}

async function writeRuntimeConfig(directory: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(join(directory, ".zcode", "cli"), { recursive: true });
  await writeFile(join(directory, ".zcode", "cli", "config.json"), `${JSON.stringify({
    provider: {
      zai: {
        kind: "anthropic",
        options: { apiKey: "test", baseURL: "http://127.0.0.1:9" },
        models: {
          "glm-5.3": { name: "GLM-5.3" },
          "glm-5.2": { name: "GLM-5.2" },
          "glm-5-turbo": { name: "GLM-5-Turbo" }
        }
      }
    },
    ...config
  })}\n`);
}

async function runHomeCommand(directory: string, args: string[], allowFailure = false) {
  if (!node) throw new Error("Node.js is required for plugin fixture commands.");
  const child = Bun.spawn([process.execPath, "bin/zcode.ts", ...args], {
    cwd: root,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, ZCODE_NODE: node, ZCODE_MODEL_RETRY_MAX_RETRIES: "0" },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (code !== 0 && !allowFailure) throw new Error(`fixture command failed (${args.join(" ")}): ${stderr || stdout}`);
  return { code, stdout, stderr };
}

async function installStrictAdvisorHookFixture(
  directory: string,
  mode: "valid" | "missing" | "crash" | "timeout" | "malformed" | "empty",
): Promise<string> {
  const marketplace = join(directory, "strict-advisor-marketplace");
  const plugin = join(marketplace, "plugin");
  await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
  await mkdir(join(plugin, "hooks"), { recursive: true });
  const command = mode === "missing" ? "${CLAUDE_PLUGIN_ROOT}/does-not-exist.sh" : "${CLAUDE_PLUGIN_ROOT}/hook.sh";
  await writeFile(join(marketplace, "marketplace.json"), `${JSON.stringify({
    name: "sol-advisor",
    pluginRoot: ".",
    plugins: [{ name: "sol-advisor", description: "Strict Advisor fixture", source: "./plugin", version: "1.0.0" }]
  }, null, 2)}\n`);
  await writeFile(join(plugin, ".zcode-plugin", "plugin.json"), `${JSON.stringify({
    name: "sol-advisor",
    description: "Strict Advisor fixture",
    version: "1.0.0"
  }, null, 2)}\n`);
  await writeFile(join(plugin, "hooks", "hooks.json"), `${JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "process", command, timeoutMs: mode === "timeout" ? 100 : 2_000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "process", command, timeoutMs: mode === "timeout" ? 100 : 2_000 }] }],
      PreToolUse: [{ matcher: "Agent", hooks: [{ type: "process", command, timeoutMs: mode === "timeout" ? 100 : 2_000 }] }],
      PostToolUse: [{ matcher: "Agent", hooks: [{ type: "process", command, timeoutMs: mode === "timeout" ? 100 : 2_000 }] }],
      PostToolUseFailure: [{ matcher: "Agent", hooks: [{ type: "process", command, timeoutMs: mode === "timeout" ? 100 : 2_000 }] }]
    }
  }, null, 2)}\n`);
  await writeFile(join(plugin, "hook.sh"), [
    "#!/bin/sh",
    mode === "timeout" ? "sleep 2" : mode === "crash" ? "exit 7" : "cat >> \"$CLAUDE_PLUGIN_ROOT/strict-advisor-events.jsonl\"",
    mode === "malformed" ? "printf '%s\\n' '{not-json}'" : mode === "empty" ? "exit 0" : "printf '%s\\n' '{\"continue\":true}'",
    ""
  ].join("\n"));
  await chmod(join(plugin, "hook.sh"), 0o755);
  await runHomeCommand(directory, ["plugins", "marketplace", "add", marketplace, "--yes", "--json"]);
  await runHomeCommand(directory, ["plugins", "install", "sol-advisor@sol-advisor", "--yes", "--json"]);
  const listed = JSON.parse((await runHomeCommand(directory, ["plugins", "list", "--json"])).stdout) as {
    plugins?: Array<Record<string, unknown>>
  };
  return String(listed.plugins?.find((plugin) => plugin.id === "sol-advisor@sol-advisor")?.rootPath ?? "");
}

type ProtocolRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function withRuntimeServer<T>(
  directory: string,
  action: (request: ProtocolRequest) => Promise<T>,
  environment: Record<string, string> = {},
): Promise<T> {
  if (!node) throw new Error("Node.js is required for launcher/runtime integration tests.");
  const child = Bun.spawn([node, join(root, "vendor", "zcode.cjs"), "app-server"], {
    cwd: root,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, ...environment },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  const stderr = new Response(child.stderr).text();
  const lines = createInterface({ input: Readable.fromWeb(child.stdout as never), crlfDelay: Infinity });
  const pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (result: Record<string, unknown>) => void;
  }>();
  let nextId = 1;
  const pump = (async () => {
    for await (const line of lines) {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        error?: unknown;
        result?: Record<string, unknown>;
      };
      if (message.method === "session/requestRuntimePreferences" && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({
          id: message.id,
          result: {
            askUserQuestionAutoResolutionEnabled: true,
            memoryEnabled: false,
            modelContextBudgetStrategy: "preflight-v1",
            nativeSearchEnhancementsEnabled: true
          }
        })}\n`);
        continue;
      }
      const waiter = message.id === undefined ? undefined : pending.get(message.id);
      if (!waiter || message.id === undefined) continue;
      pending.delete(message.id);
      if (message.error || !message.result) waiter.reject(new Error(JSON.stringify(message.error ?? message)));
      else waiter.resolve(message.result);
    }
  })();
  const request: ProtocolRequest = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    return await action(request);
  } finally {
    const runtimeError = await Promise.race([
      stderr,
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 10))
    ]);
    for (const waiter of pending.values()) waiter.reject(new Error(runtimeError || "runtime server stopped"));
    pending.clear();
    lines.close();
    child.stdin.end();
    child.kill();
    await child.exited;
    await pump;
  }
}

async function createRuntimeSession(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-session-"));
  await writeRuntimeConfig(directory, config);
  try {
    return await withRuntimeServer(directory, (request) => request("session/create", {
      workspace: { workspacePath: root, workspaceKey: root }
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function anthropicStream(
  model: string,
  content: { text: string } | { toolInput: Record<string, unknown> },
): Response {
  const tool = "toolInput" in content;
  const block = tool
    ? { type: "tool_use", id: "toolu_route", name: "Agent", input: {} }
    : { type: "text", text: "" };
  const delta = tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(content.toolInput) }
    : { type: "text_delta", text: content.text };
  const events = [
    ["message_start", {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 }
    }],
    ["message_stop", { type: "message_stop" }]
  ];
  return new Response(`${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join("\n\n")}\n\n`, {
    headers: { "content-type": "text/event-stream" }
  });
}

async function runAgentRouteProbe(
  runInBackground: boolean,
  withHooks = false,
  childFailure = false,
): Promise<{
  childRoute: Record<string, unknown>;
  restored: Record<string, unknown>;
  restoredRoute: Record<string, unknown>;
  hookEvents?: Array<Record<string, unknown>>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-agent-"));
  let hookRoot = "";
  let parentCalls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as { model?: unknown };
      const model = String(body.model ?? "");
      if (model === "glm-5.3" && parentCalls++ === 0) {
        return anthropicStream(model, {
          toolInput: {
            description: "route probe",
            prompt: "Reply with child done.",
            subagent_type: "general-purpose",
            run_in_background: runInBackground
          }
        });
      }
      if (childFailure && model === "glm-5.2") {
        return new Response(JSON.stringify({ error: { message: "fixture child failure" } }), {
          headers: { "content-type": "application/json" },
          status: 500
        });
      }
      return anthropicStream(model, { text: model === "glm-5.2" ? "child done" : "parent done" });
    }
  });
  try {
    if (withHooks) hookRoot = await installStrictAdvisorHookFixture(directory, "valid");
    await writeRuntimeConfig(directory, {
      provider: {
        zai: {
          kind: "anthropic",
          options: { apiKey: "test", baseURL: `http://127.0.0.1:${provider.port}` },
          models: {
            "glm-5.3": { name: "GLM-5.3" },
            "glm-5.2": { name: "GLM-5.2" },
            "glm-5-turbo": { name: "GLM-5-Turbo" }
          }
        }
      },
      model: { main: "zai/glm-5.2", lite: "zai/glm-5-turbo" },
      hooks: { enabled: false },
      subagents: { autoBackgroundMs: 60_000 },
      plugins: {
        enabled: true,
        enabledPlugins: { "sol-advisor@sol-advisor": true },
        options: {
          "sol-advisor@sol-advisor": {
            advisor_model: "zai/glm-5.3",
            advisor_effort: "low",
            grunt_model: "zai/glm-5.2",
            grunt_effort: "high"
          }
        }
      }
    });
    return await withRuntimeServer(directory, async (request) => {
      const workspace = { workspacePath: root, workspaceKey: root };
      const created = await request("session/create", {
        workspace,
        mode: "yolo",
        titleGenerationEnabled: false,
        toolAllowlist: ["Agent"]
      });
      const sessionId = String((created.session as Record<string, unknown>).sessionId);
      await request("session/send", { sessionId, inputId: "agent-route", content: "Delegate this." });
      let childSessionId = "";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await Bun.sleep(50);
        let subagents: Record<string, unknown>;
        try {
          subagents = await request("session/subagents", { sessionId });
        } catch (error) {
          if (String(error).includes("Session not found")) continue;
          throw error;
        }
        const ended = ((subagents.ended as Record<string, unknown>).items as Array<Record<string, unknown>>)[0];
        if (!ended) continue;
        const expectedStatus = childFailure ? "failed" : "success";
        if (ended.status !== expectedStatus) throw new Error(`Agent route probe ended with ${String(ended.status)}`);
        childSessionId = String(ended.childSessionId);
        break;
      }
      if (!childSessionId) throw new Error("Agent route probe did not complete");
      const database = new Database(join(directory, ".zcode", "cli", "db", "db.sqlite"), { readonly: true });
      let childRoute: Record<string, unknown>;
      try {
        const row = database.query("select data from session_entry where id = ?").get(
          `${childSessionId}:runtime-model-selection`,
        ) as { data: string } | null;
        if (!row) throw new Error("Agent route record is missing");
        childRoute = JSON.parse(row.data) as Record<string, unknown>;
      } finally {
        database.close();
      }
      const restored = await request("session/resume", { sessionId: childSessionId });
      const restoredDatabase = new Database(join(directory, ".zcode", "cli", "db", "db.sqlite"), { readonly: true });
      let restoredRoute: Record<string, unknown>;
      try {
        const row = restoredDatabase.query("select data from session_entry where id = ?").get(
          `${childSessionId}:runtime-model-selection`,
        ) as { data: string } | null;
        if (!row) throw new Error("Restored Agent route record is missing");
        restoredRoute = JSON.parse(row.data) as Record<string, unknown>;
      } finally {
        restoredDatabase.close();
      }
      const hookEvents = hookRoot && await Bun.file(join(hookRoot, "strict-advisor-events.jsonl")).exists()
        ? (await Bun.file(join(hookRoot, "strict-advisor-events.jsonl")).text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        : undefined;
      return { childRoute, restored, restoredRoute, hookEvents };
    }, childFailure ? { ZCODE_MODEL_RETRY_MAX_RETRIES: "0" } : {});
  } finally {
    provider.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

async function runOverride(
  mode: "success" | "nonzero" | "signal",
): Promise<{ code: number; privateHome: string }> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-launcher-cleanup-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ model: { main: "zai/old", lite: "zai/lite" } }));
  const args = ["--print", "hello", "--model=zai/glm-5.2", "--reasoning-effort=high", `--settings=${configPath}`];
  try {
    const fakeNode = join(directory, "fake-node");
    await writeFile(fakeNode, [
      "#!/bin/sh",
      "printf '%s\\n' \"$HOME\" >&2",
      mode === "nonzero" ? "exit 9" : mode === "signal" ? "sleep 2" : "exit 0",
      ""
    ].join("\n"));
    await chmod(fakeNode, 0o755);
    const child = Bun.spawn([process.execPath, "bin/zcode.ts", ...args], {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_NODE: fakeNode },
      stdout: "pipe",
      stderr: "pipe"
    });
    if (mode === "signal") setTimeout(() => child.kill("SIGTERM"), 500);
    const code = await child.exited;
    const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, privateHome: stderr.trim().split("\n")[0] ?? "" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("launcher/runtime integration", () => {
  test("removes private override directories across runtime lifecycle exits", async () => {
    for (const mode of ["success", "nonzero", "signal"] as const) {
      const result = await runOverride(mode);
      expect(result.privateHome).toContain("/zcode-settings-");
      expect(await Bun.file(result.privateHome).exists()).toBe(false);
      if (mode === "nonzero") expect(result.code).toBe(9);
    }
  }, 30_000);

  test("rejects a keyless prompt before starting the runtime or creating a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-keyless-prompt-"));
    const fakeNode = join(directory, "fake-node");
    await writeFile(fakeNode, "#!/bin/sh\nprintf 'RUNTIME_STARTED'\nexit 99\n");
    await chmod(fakeNode, 0o755);
    try {
      const result = await run(["--cwd", directory, "--prompt", "offline test"], "", {
        HOME: directory, USERPROFILE: directory, ZCODE_NODE: fakeNode, ANTHROPIC_API_KEY: ""
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("No model request was sent");
      expect(result.stdout).not.toContain("RUNTIME_STARTED");
      expect(await Bun.file(join(directory, ".zcode", "cli", "db", "db.sqlite")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps TUI runtime diagnostics out of the interactive terminal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-launcher-stderr-"));
    const fakeNode = join(directory, "fake-node");
    const logPath = join(directory, "tui-runtime.log");
    await writeFile(fakeNode, [
      "#!/bin/sh",
      "printf '%s\\n' 'AI SDK Warning: cacheControl breakpoint limit' >&2",
      "printf '%s\\n' 'ProviderBusinessError: No available channel for model GLM-5.2' >&2",
      "printf '\\033[2J' >&2",
      "exit \"${FAKE_NODE_EXIT:-0}\"",
      ""
    ].join("\n"));
    await chmod(fakeNode, 0o755);
    try {
      const tui = await run(["--cwd", directory, "tui"], "", {
        ZCODE_NODE: fakeNode,
        ZCODE_TUI_RUNTIME_LOG: logPath
      });
      expect(tui.code).toBe(0);
      expect(tui.stderr).not.toContain("ProviderBusinessError");
      expect(tui.stderr).not.toContain("cacheControl breakpoint limit");
      const tuiLog = await Bun.file(logPath).text();
      expect(tuiLog).toContain("ProviderBusinessError");
      expect(tuiLog).toContain("cacheControl breakpoint limit");

      const failed = await run(["--cwd", directory, "tui"], "", {
        FAKE_NODE_EXIT: "7",
        ZCODE_NODE: fakeNode,
        ZCODE_TUI_RUNTIME_LOG: logPath
      });
      expect(failed.code).toBe(7);
      expect(failed.stderr).toContain("ZCode runtime exited with status 7");
      expect(failed.stderr).toContain(`Diagnostics: ${logPath}`);
      expect(failed.stderr).not.toContain("ProviderBusinessError");

      const print = await run(["--print", "hello"], "", {
        ZCODE_NODE: fakeNode,
        ANTHROPIC_API_KEY: "fixture-only-key"
      });
      expect(print.code).toBe(0);
      expect(print.stderr).toContain("ProviderBusinessError");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rotates the bounded TUI diagnostic log between invocations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-launcher-log-rotation-"));
    const fakeNode = join(directory, "fake-node");
    const logPath = join(directory, "tui-runtime.log");
    await writeFile(fakeNode, [
      "#!/bin/sh",
      "printf '%s\\n' 'fresh diagnostic' >&2",
      "exit 0",
      ""
    ].join("\n"));
    await chmod(fakeNode, 0o755);
    await writeFile(logPath, Buffer.alloc(2 * 1024 * 1024, "x"));
    if (process.platform !== "win32") await chmod(logPath, 0o644);
    try {
      const result = await run(["tui"], "", {
        ZCODE_NODE: fakeNode,
        ZCODE_TUI_RUNTIME_LOG: logPath
      });
      expect(result.code).toBe(0);
      expect(await Bun.file(logPath).text()).toContain("fresh diagnostic");
      expect(Bun.file(`${logPath}.1`).size).toBe(2 * 1024 * 1024);
      if (process.platform !== "win32") {
        expect((await stat(logPath)).mode & 0o777).toBe(0o600);
        expect((await stat(`${logPath}.1`)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps non-agent runtime subcommands usable", async () => {
    const doctor = await run(["doctor", "--json"]);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ cli: { version: readRuntimeVersion() } });

    const plugins = await run(["plugins", "list", "--json"]);
    expect(plugins.code).toBe(0);
    expect(JSON.parse(plugins.stdout).plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "browser-use", enabled: true })
    ]));

    const skills = await run(["skills", "list", "--json"]);
    expect(skills.code).toBe(0);
    expect(JSON.parse(skills.stdout).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: "browser-use:control-browser" })
    ]));
  }, 30_000);

  test("lists and inspects workspace custom commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-custom-commands-"));
    try {
      const commandDirectory = join(directory, ".zcode", "commands");
      await mkdir(commandDirectory, { recursive: true });
      await writeFile(join(commandDirectory, "smoke.md"), [
        "---",
        "description: Smoke command description.",
        "argument-hint: <topic>",
        "skills: browser-use:control-browser",
        "---",
        "",
        "Summarize $ARGUMENTS.",
        ""
      ].join("\n"));

      const listed = await run(["--cwd", directory, "commands", "list", "--json"]);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        commands: expect.arrayContaining([
          expect.objectContaining({
            argumentHint: "<topic>",
            description: "Smoke command description.",
            name: "smoke",
            scope: "project",
            skills: ["browser-use:control-browser"],
            source: "zcode"
          })
        ]),
        cwd: directory,
        diagnostics: [],
        totalDiscovered: 1
      });

      const inspected = await run(["--cwd", directory, "commands", "inspect", "smoke", "--json"]);
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        command: {
          content: "Summarize $ARGUMENTS.",
          metadata: expect.objectContaining({
            argumentHint: "<topic>",
            description: "Smoke command description.",
            name: "smoke",
            scope: "project",
            skills: ["browser-use:control-browser"],
            source: "zcode"
          }),
          truncated: false
        },
        cwd: directory,
        diagnostics: []
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("passes app-server through unchanged and exposes Plugin references", async () => {
    const workspacePath = root.replace(/\/$/u, "");
    const request = {
      id: 1,
      method: "plugins/referenceCatalog",
      params: {
        workspace: { workspacePath, workspaceKey: workspacePath }
      }
    };
    const result = await run(["app-server"], `${JSON.stringify(request)}\n`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 1,
      result: {
        plugins: expect.arrayContaining([
          expect.objectContaining({
            pluginId: "browser-use@zcode-plugins-official",
            skillQualifiedNames: expect.arrayContaining(["browser-use:control-browser"])
          })
        ])
      }
    });
  }, 30_000);

  test("applies a configured main reasoning effort in a real runtime session", async () => {
    const snapshot = await createRuntimeSession({
      model: {
        main: "zai/glm-5.2",
        lite: "zai/glm-5-turbo",
        mainThoughtLevel: "high",
        liteThoughtLevel: "enabled"
      }
    });
    expect(snapshot).toMatchObject({
      session: { model: { providerId: "zai", modelId: "glm-5.2" } },
      settings: { thoughtLevel: { current: "high" } }
    });
  }, 30_000);

  test("rejects an unsupported runtime effort before provider invocation", async () => {
    await expect(createRuntimeSession({
      model: {
        main: "zai/glm-5.2",
        lite: "zai/glm-5-turbo",
        mainThoughtLevel: "ultra",
        liteThoughtLevel: "enabled"
      }
    })).rejects.toThrow("ZCODE_RUNTIME_ROUTE_UNSUPPORTED_THOUGHT_LEVEL");
  }, 30_000);

  test("applies exact Advisor settings in a real runtime session", async () => {
    const snapshot = await createRuntimeSession({
      model: {
        main: "zai/glm-5.2",
        lite: "zai/glm-5-turbo",
        mainThoughtLevel: "high",
        liteThoughtLevel: "enabled"
      },
      plugins: {
        enabled: true,
        enabledPlugins: { "sol-advisor@sol-advisor": true },
        options: {
          "sol-advisor@sol-advisor": {
            advisor_model: "zai/glm-5.3",
            advisor_effort: "low",
            grunt_model: "zai/glm-5.2",
            grunt_effort: "high"
          }
        }
      }
    });
    expect(snapshot).toMatchObject({
      session: { model: { providerId: "zai", modelId: "glm-5.3" } },
      settings: { thoughtLevel: { current: "low" } }
    });
  }, 30_000);

  test("emits exactly one ODW attestation on a handled provider failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-provider-failure-"));
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: { message: "fixture provider failure" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    });
    try {
      await writeRuntimeConfig(directory, {
        provider: {
          zai: {
            kind: "anthropic",
            options: { apiKey: "test", baseURL: `http://127.0.0.1:${provider.port}` },
            models: {
              "glm-5.2": { name: "GLM-5.2" }
            }
          }
        },
        model: { main: "zai/glm-5.2", lite: "zai/glm-5.2", mainThoughtLevel: "high" }
      });
      const settingsPath = join(directory, ".zcode", "cli", "config.json");
      const result = await run([
        "--prompt", "provider failure fixture",
        "--model=zai/glm-5.2",
        "--reasoning-effort=high",
        `--settings=${settingsPath}`
      ], "", { ZCODE_ODW_PROTOCOL: "1", ZCODE_MODEL_RETRY_MAX_RETRIES: "0" });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(envelope).toMatchObject({
        type: "zcode_result",
        exitCode: expect.any(Number),
        runtimeAttestation: {
          type: "zcode_runtime_attestation",
          route: "odw",
          model: "zai/glm-5.2",
          reasoningEffort: "high",
          role: "main",
          parentSessionId: null,
          policySource: null,
          rolePolicy: null,
          rolePolicyFingerprint: null
        }
      });
      expect((result.stdout.match(/zcode_runtime_attestation/g) ?? []).length).toBe(1);
    } finally {
      provider.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  for (const mode of ["valid", "missing", "crash", "timeout", "malformed", "empty"] as const) {
    test(`executes exact Advisor plugin hooks with user hooks disabled (${mode})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `zcode-strict-advisor-hook-${mode}-`));
      try {
        await installStrictAdvisorHookFixture(directory, mode);
        await writeRuntimeConfig(directory, {
          model: { main: "zai/glm-5.3", lite: "zai/glm-5.2", mainThoughtLevel: "low", liteThoughtLevel: "high" },
          hooks: { enabled: false },
          plugins: {
            enabled: true,
            enabledPlugins: { "sol-advisor@sol-advisor": true },
            options: {
              "sol-advisor@sol-advisor": {
                advisor_model: "zai/glm-5.3",
                advisor_effort: "low",
                grunt_model: "zai/glm-5.2",
                grunt_effort: "high"
              }
            }
          }
        });
        const listedFixture = JSON.parse((await runHomeCommand(directory, ["plugins", "list", "--json"])).stdout) as {
          plugins?: Array<Record<string, unknown>>
        };
        expect(listedFixture.plugins).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "sol-advisor@sol-advisor", enabled: true, hookDetails: expect.any(Array) })
        ]));
        const hookRoot = String(listedFixture.plugins?.find((plugin) => plugin.id === "sol-advisor@sol-advisor")?.rootPath ?? "");
        expect(hookRoot).not.toBe("");
        expect(await Bun.file(join(hookRoot, "hook.sh")).exists()).toBe(true);
        expect(await Bun.file(join(hookRoot, "hooks", "hooks.json")).exists()).toBe(true);
        expect((listedFixture.plugins?.find((plugin) => plugin.id === "sol-advisor@sol-advisor")?.hookDetails as unknown[] | undefined)?.length).toBeGreaterThan(0);
        const headless = await runHomeCommand(directory, ["--prompt", "Trigger hooks."], true);
        if (mode === "valid") {
          expect(await Bun.file(join(hookRoot, "strict-advisor-events.jsonl")).exists()).toBe(true);
        } else {
          expect(headless.code).not.toBe(0);
          if (!headless.stderr.includes("ZCODE_STRICT_ADVISOR_HOOK_FAILURE")) {
            throw new Error(`Strict Advisor headless failure was not attributed for ${mode}: ${headless.stderr}`);
          }
        }
        await withRuntimeServer(directory, async (request) => {
          const create = request("session/create", {
            workspace: { workspacePath: directory, workspaceKey: directory },
            mode: "yolo",
            titleGenerationEnabled: false
          });
          const result = await create;
          const sessionId = String((result.session as Record<string, unknown>).sessionId);
          const send = request("session/send", { sessionId, inputId: `strict-hook-${mode}`, content: "Trigger hooks." });
          if (mode === "valid") {
            await send.catch(() => undefined);
            expect(result).toMatchObject({ session: { sessionId: expect.any(String) } });
            let sessionStart: Record<string, unknown> | undefined;
            for (let attempt = 0; attempt < 200 && !sessionStart; attempt += 1) {
              await Bun.sleep(50);
              const events = (await Bun.file(join(hookRoot, "strict-advisor-events.jsonl")).text())
                .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
              sessionStart = events.find((event) => {
                const attestation = event.runtimeAttestation as Record<string, unknown> | undefined;
                return event.hookEventName === "SessionStart" && attestation?.sessionId === sessionId;
              });
            }
            expect(sessionStart).toMatchObject({
              hookEventName: "SessionStart",
              runtimeAttestation: {
                route: "native",
                role: "main",
                parentSessionId: null,
                model: "zai/glm-5.3",
                reasoningEffort: "low"
              }
            });
          } else {
            await send;
            let strictFailure = "";
            for (let attempt = 0; attempt < 40 && !strictFailure; attempt += 1) {
              try {
                await request("session/send", { sessionId, inputId: `strict-hook-retry-${mode}-${attempt}`, content: "Retry after strict hook failure." });
              } catch (error) {
                const message = String(error);
                if (message.includes("zcode_strict_advisor_hook_failure")
                  && message.includes("ZCODE_STRICT_ADVISOR_HOOK_FAILURE")) {
                  strictFailure = message;
                }
              }
              if (!strictFailure) await Bun.sleep(50);
            }
            expect(strictFailure).not.toBe("");
          }
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);
  }

  test("keeps ambiguous Advisor settings on ordinary routing", async () => {
    const snapshot = await createRuntimeSession({
      model: {
        main: "zai/glm-5.2",
        lite: "zai/glm-5-turbo",
        mainThoughtLevel: "high",
        liteThoughtLevel: "enabled"
      },
      plugins: {
        enabled: true,
        enabledPlugins: {
          "sol-advisor@alternate": true,
          "sol-advisor@sol-advisor": true
        },
        options: {
          "sol-advisor@sol-advisor": {
            advisor_model: "zai/glm-5.3",
            advisor_effort: "low",
            grunt_model: "zai/glm-5.2",
            grunt_effort: "high"
          }
        }
      }
    });
    expect(snapshot).toMatchObject({
      session: { model: { providerId: "zai", modelId: "glm-5.2" } },
      settings: { thoughtLevel: { current: "high" } }
    });
  }, 30_000);

  test("restores a persisted Advisor route after Plugin settings change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-restore-"));
    const workspace = { workspacePath: root, workspaceKey: root };
    let sessionId = "";
    let parentCalls = 0;
    const modelsSeen: string[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json() as { model?: unknown };
        const model = String(body.model ?? "");
        modelsSeen.push(model);
        if (model === "glm-5.3" && parentCalls++ === 1) {
          return anthropicStream(model, {
            toolInput: {
              description: "combined route probe",
              prompt: "Reply with child done.",
              subagent_type: "general-purpose",
              run_in_background: false
            }
          });
        }
        return anthropicStream(model, { text: "route done" });
      }
    });
    try {
      const hookRoot = await installStrictAdvisorHookFixture(directory, "valid");
      await writeRuntimeConfig(directory, {
        provider: {
          zai: {
            kind: "anthropic",
            options: { apiKey: "test", baseURL: `http://127.0.0.1:${provider.port}` },
            models: {
              "glm-5.3": { name: "GLM-5.3" },
              "glm-5.2": { name: "GLM-5.2" },
              "glm-5-turbo": { name: "GLM-5-Turbo" }
            }
          }
        },
        model: { main: "zai/glm-5.2", lite: "zai/glm-5-turbo" },
        hooks: { enabled: false },
        plugins: {
          enabled: true,
          enabledPlugins: { "sol-advisor@sol-advisor": true },
          options: {
            "sol-advisor@sol-advisor": {
              advisor_model: "zai/glm-5.3",
              advisor_effort: "low",
              grunt_model: "zai/glm-5.2",
              grunt_effort: "high"
            }
          }
        }
      });
      await withRuntimeServer(directory, async (request) => {
        const created = await request("session/create", {
          workspace,
          persistence: "immediate",
          titleGenerationEnabled: false,
          toolAllowlist: ["Agent"]
        });
        sessionId = String((created.session as Record<string, unknown>).sessionId);
        await request("session/send", { sessionId, inputId: "persist-policy-a", content: "Persist this route." });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          await Bun.sleep(50);
          const snapshot = await request("session/read", { sessionId });
          const projection = snapshot.projection as Record<string, unknown>;
          if (projection.status === "idle" && (snapshot.messages as unknown[]).length >= 2) break;
        }
        let persisted: { data: string } | null = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await Bun.sleep(50);
          if (!await Bun.file(join(directory, ".zcode", "cli", "db", "db.sqlite")).exists()) continue;
          const database = new Database(join(directory, ".zcode", "cli", "db", "db.sqlite"), { readonly: true });
          try {
            persisted = database.query("select data from session_entry where id = ?").get(
              `${sessionId}:runtime-model-selection`,
            ) as { data: string } | null;
          } finally {
            database.close();
          }
          if (persisted) break;
        }
        expect(JSON.parse(persisted?.data ?? "null")).toMatchObject({
          modelId: "glm-5.3",
          providerId: "zai",
          thoughtLevel: "low",
          role: "main",
          policySource: "new",
          rolePolicy: {
            advisorModel: "zai/glm-5.3",
            advisorEffort: "low",
            gruntModel: "zai/glm-5.2",
            gruntEffort: "high"
          }
        });
      });

      await writeRuntimeConfig(directory, {
        provider: {
          zai: {
            kind: "anthropic",
            options: { apiKey: "test", baseURL: `http://127.0.0.1:${provider.port}` },
            models: {
              "glm-5.3": { name: "GLM-5.3" },
              "glm-5.2": { name: "GLM-5.2" },
              "glm-5-turbo": { name: "GLM-5-Turbo" }
            }
          }
        },
        model: { main: "zai/glm-5.3", lite: "zai/glm-5-turbo" },
        hooks: { enabled: false },
        plugins: {
          enabled: true,
          enabledPlugins: { "sol-advisor@sol-advisor": true },
          options: {
            "sol-advisor@sol-advisor": {
              advisor_model: "zai/glm-5.2",
              advisor_effort: "high",
              grunt_model: "zai/glm-5-turbo",
              grunt_effort: "enabled"
            }
          }
        }
      });
      await withRuntimeServer(directory, async (request) => {
        const restored = await request("session/resume", { sessionId });
        expect(restored).toMatchObject({
          session: { model: { providerId: "zai", modelId: "glm-5.3" } },
          settings: { thoughtLevel: { current: "low" } }
        });
        await request("session/send", { sessionId, inputId: "combined-route", content: "Delegate this." });
        let childSessionId = "";
        for (let attempt = 0; attempt < 200; attempt += 1) {
          await Bun.sleep(50);
          const subagents = await request("session/subagents", { sessionId });
          const ended = ((subagents.ended as Record<string, unknown>).items as Array<Record<string, unknown>>)[0];
          if (!ended) continue;
          if (ended.status !== "success") throw new Error(`Combined route child ended with ${String(ended.status)}`);
          childSessionId = String(ended.childSessionId);
          break;
        }
        if (!childSessionId) {
          throw new Error(`Combined route child did not run; provider models: ${modelsSeen.join(",")}`);
        }
        const database = new Database(join(directory, ".zcode", "cli", "db", "db.sqlite"), { readonly: true });
        try {
          const childRow = database.query("select data from session_entry where id = ?").get(
            `${childSessionId}:runtime-model-selection`,
          ) as { data: string } | null;
          expect(JSON.parse(childRow?.data ?? "null")).toMatchObject({
            modelId: "glm-5.2",
            providerId: "zai",
            thoughtLevel: "high",
            role: "lite",
            policySource: "parent",
            rolePolicy: {
              advisorModel: "zai/glm-5.3",
              advisorEffort: "low",
              gruntModel: "zai/glm-5.2",
              gruntEffort: "high"
            }
          });
        } finally {
          database.close();
        }
        const fresh = await request("session/create", { workspace });
        expect(fresh).toMatchObject({
          session: { model: { providerId: "zai", modelId: "glm-5.2" } },
          settings: { thoughtLevel: { current: "high" } }
        });
        const freshSessionId = String((fresh.session as Record<string, unknown>).sessionId);
        await request("session/send", { sessionId: freshSessionId, inputId: "fresh-policy-b", content: "Reply once." });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          await Bun.sleep(50);
          const snapshot = await request("session/read", { sessionId: freshSessionId });
          const projection = snapshot.projection as Record<string, unknown>;
          if (projection.status === "idle" && (snapshot.messages as unknown[]).length >= 2) break;
        }

        const events = (await Bun.file(join(hookRoot, "strict-advisor-events.jsonl")).text())
          .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        const attestations = events
          .map((event) => event.runtimeAttestation as Record<string, unknown> | undefined)
          .filter((value): value is Record<string, unknown> => value !== undefined);
        const restoredRootEvents = attestations.filter((value) => value.sessionId === sessionId
          && value.role === "main" && value.policySource === "persisted");
        const restoredRoot = restoredRootEvents[0];
        const restoredChild = attestations.find((value) => value.sessionId === childSessionId && value.role === "lite");
        const freshRoot = attestations.find((value) => value.sessionId === freshSessionId && value.role === "main");
        expect(restoredRoot).toMatchObject({
          parentSessionId: null,
          policySource: "persisted",
          model: "zai/glm-5.3",
          reasoningEffort: "low",
          rolePolicy: {
            advisorModel: "zai/glm-5.3",
            advisorEffort: "low",
            gruntModel: "zai/glm-5.2",
            gruntEffort: "high"
          }
        });
        if (!restoredChild) throw new Error(`Restored child attestation missing: ${JSON.stringify(attestations)}`);
        expect(restoredChild).toMatchObject({
          parentSessionId: sessionId,
          policySource: "parent",
          model: "zai/glm-5.2",
          reasoningEffort: "high",
          rolePolicy: restoredRoot?.rolePolicy
        });
        expect(freshRoot).toMatchObject({
          parentSessionId: null,
          policySource: "new",
          model: "zai/glm-5.2",
          reasoningEffort: "high",
          rolePolicy: {
            advisorModel: "zai/glm-5.2",
            advisorEffort: "high",
            gruntModel: "zai/glm-5-turbo",
            gruntEffort: "enabled"
          }
        });
        const policyAHash = createHash("sha256").update(JSON.stringify(restoredRoot?.rolePolicy)).digest("hex");
        expect(restoredRootEvents.length).toBeGreaterThanOrEqual(3);
        for (const attestation of restoredRootEvents) {
          expect(attestation).toMatchObject({
            model: "zai/glm-5.3",
            reasoningEffort: "low",
            rolePolicy: restoredRoot?.rolePolicy,
            rolePolicyFingerprint: policyAHash
          });
        }
        expect(restoredRoot?.rolePolicyFingerprint).toBe(policyAHash);
        expect(restoredChild?.rolePolicyFingerprint).toBe(policyAHash);
        expect(freshRoot?.rolePolicyFingerprint).not.toBe(policyAHash);
      });
    } finally {
      provider.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("runs a foreground native Agent on the persisted grunt route", async () => {
    const result = await runAgentRouteProbe(false);
    expect(result.childRoute).toMatchObject({
      modelId: "glm-5.2",
      providerId: "zai",
      thoughtLevel: "high",
      role: "lite",
      policySource: "parent",
      rolePolicy: {
        advisorModel: "zai/glm-5.3",
        advisorEffort: "low",
        gruntModel: "zai/glm-5.2",
        gruntEffort: "high"
      }
    });
    expect(result.restored).toMatchObject({
      session: { model: { providerId: "zai", modelId: "glm-5.2" } },
      settings: { thoughtLevel: { current: "high" } }
    });
    expect(result.restoredRoute).toMatchObject({
      modelId: "glm-5.2",
      providerId: "zai",
      thoughtLevel: "high",
      role: "lite",
      policySource: "parent",
      rolePolicy: {
        advisorModel: "zai/glm-5.3",
        advisorEffort: "low",
        gruntModel: "zai/glm-5.2",
        gruntEffort: "high"
      }
    });
  }, 30_000);

  test("captures runtime attestations on real primary and Agent child hook payloads", async () => {
    const result = await runAgentRouteProbe(false, true);
    const events = result.hookEvents ?? [];
    const nativeEvents = events.filter((event) => event.runtimeAttestation) as Array<Record<string, unknown>>;
    expect(nativeEvents.map((event) => event.hookEventName)).toEqual(expect.arrayContaining([
      "SessionStart", "PreToolUse", "PostToolUse"
    ]));
    const attestations = nativeEvents.map((event) => event.runtimeAttestation as Record<string, unknown>);
    const root = attestations.find((attestation) => attestation.role === "main");
    const child = attestations.find((attestation) => attestation.role === "lite");
    const rootPostToolUse = nativeEvents.find((event) => event.hookEventName === "PostToolUse"
      && (event.runtimeAttestation as Record<string, unknown> | undefined)?.role === "main"
      && event.toolName === "Agent");
    expect(root).toMatchObject({
      route: "native",
      role: "main",
      parentSessionId: null,
      policySource: "new",
      model: "zai/glm-5.3",
      reasoningEffort: "low",
      rolePolicy: {
        advisorModel: "zai/glm-5.3",
        advisorEffort: "low",
        gruntModel: "zai/glm-5.2",
        gruntEffort: "high"
      }
    });
    expect(child).toMatchObject({
      route: "native",
      role: "lite",
      parentSessionId: expect.any(String),
      policySource: "parent",
      model: "zai/glm-5.2",
      reasoningEffort: "high",
      rolePolicy: root?.rolePolicy
    });
    const policy = root?.rolePolicy as Record<string, string>;
    expect(root?.rolePolicyFingerprint).toBe(createHash("sha256").update(JSON.stringify(policy)).digest("hex"));
    expect(child?.rolePolicyFingerprint).toBe(root?.rolePolicyFingerprint);
    expect(rootPostToolUse?.childRuntimeEvidence).toMatchObject({
      childSessionId: child?.sessionId,
      parentSessionId: root?.runtimeId,
      parentToolCallId: rootPostToolUse?.toolCallId,
      state: "completed",
      runtimeAttestation: child
    });
  }, 45_000);

  test("runs and resumes a background native Agent on the persisted grunt route", async () => {
    const result = await runAgentRouteProbe(true);
    expect(result.childRoute).toMatchObject({
      modelId: "glm-5.2",
      providerId: "zai",
      thoughtLevel: "high",
      role: "lite",
      policySource: "parent",
      rolePolicy: {
        advisorModel: "zai/glm-5.3",
        advisorEffort: "low",
        gruntModel: "zai/glm-5.2",
        gruntEffort: "high"
      }
    });
    expect(result.restored).toMatchObject({
      session: { model: { providerId: "zai", modelId: "glm-5.2" } },
      settings: { thoughtLevel: { current: "high" } }
    });
    expect(result.restoredRoute).toMatchObject({
      modelId: "glm-5.2",
      providerId: "zai",
      thoughtLevel: "high",
      role: "lite",
      policySource: "parent",
      rolePolicy: {
        advisorModel: "zai/glm-5.3",
        advisorEffort: "low",
        gruntModel: "zai/glm-5.2",
        gruntEffort: "high"
      }
    });
  }, 30_000);

  test("does not expose completed child evidence for a background Agent launch", async () => {
    const result = await runAgentRouteProbe(true, true);
    const events = result.hookEvents ?? [];
    const rootPostToolUse = events.find((event) => event.hookEventName === "PostToolUse"
      && (event.runtimeAttestation as Record<string, unknown> | undefined)?.role === "main"
      && event.toolName === "Agent");
    expect(rootPostToolUse?.childRuntimeEvidence).toBeNull();
  }, 45_000);

  test("does not expose completed child evidence on a failed foreground Agent", async () => {
    const result = await runAgentRouteProbe(false, true, true);
    const events = result.hookEvents ?? [];
    const rootFailure = events.find((event) => event.hookEventName === "PostToolUseFailure"
      && (event.runtimeAttestation as Record<string, unknown> | undefined)?.role === "main"
      && event.toolName === "Agent");
    expect(rootFailure).toMatchObject({
      error_details: { message: expect.any(String) },
      isInterrupt: false
    });
    expect(rootFailure?.childRuntimeEvidence).toBeUndefined();
  }, 45_000);

  test("resolves a real Plugin install dry-run without changing storage", async () => {
    const result = await run([
      "plugins",
      "install",
      "browser-use@zcode-plugins-official",
      "--dry-run",
      "--json"
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      description: {
        components: expect.arrayContaining([
          expect.objectContaining({
            kind: "skill",
            items: expect.arrayContaining([
              expect.objectContaining({ name: "control-browser" })
            ])
          })
        ])
      },
      plan: {
        dependencyClosure: [],
        diagnostics: []
      }
    });
  }, 30_000);

  test("adds a local marketplace and installs its Plugin end to end", async () => {
    const marketplace = join(home, "fixture-marketplace");
    const plugin = join(marketplace, "plugin");
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills", "smoke-skill"), { recursive: true });
    await writeFile(join(marketplace, "marketplace.json"), `${JSON.stringify({
      name: "cli-smoke-marketplace",
      pluginRoot: ".",
      plugins: [{
        description: "CLI smoke plugin",
        name: "cli-smoke-plugin",
        source: "./plugin",
        version: "1.0.0"
      }]
    }, null, 2)}\n`);
    await writeFile(join(plugin, ".zcode-plugin", "plugin.json"), `${JSON.stringify({
      description: "CLI smoke plugin",
      name: "cli-smoke-plugin",
      skills: "skills",
      version: "1.0.0"
    }, null, 2)}\n`);
    await writeFile(join(plugin, "skills", "smoke-skill", "SKILL.md"), [
      "---",
      "name: smoke-skill",
      "description: Verify marketplace installation.",
      "---",
      "",
      "Verify installation.",
      ""
    ].join("\n"));

    const added = await run(["plugins", "marketplace", "add", marketplace, "--yes", "--json"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({
      marketplace: { id: "cli-smoke-marketplace", pluginCount: 1 },
      diagnostics: []
    });

    const installed = await run([
      "plugins",
      "install",
      "cli-smoke-plugin@cli-smoke-marketplace",
      "--yes",
      "--json"
    ]);
    expect(installed.code).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      installedPlugins: expect.arrayContaining([
        expect.objectContaining({
          enabled: true,
          id: "cli-smoke-plugin@cli-smoke-marketplace"
        })
      ]),
      diagnostics: []
    });

    const plugins = await run(["plugins", "list", "--json"]);
    expect(JSON.parse(plugins.stdout).plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        enabled: true,
        id: "cli-smoke-plugin@cli-smoke-marketplace",
        skillCount: 1
      })
    ]));

    const skills = await run(["skills", "list", "--json"]);
    expect(JSON.parse(skills.stdout).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: "cli-smoke-plugin:smoke-skill" })
    ]));
  }, 30_000);
});
