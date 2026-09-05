import { describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  clearSetupPending,
  ensureUserConfig,
  markSetupPending,
  readConfiguredModelAccess,
  readSetupPending,
  userConfigPath
} from "../src/model-access.ts";
import {
  firstRunSetupEnv,
  extractRuntimeAttestation,
  extractUsageFooter,
  formatVersionOutput,
  isTuiRuntimeInvocation,
  isVersionInvocation,
  normalizeLoginArgs,
  prepareRuntimeOverrides,
  prepareModelOverride,
  readRuntimeCliOptionTypes,
  runProtocolRuntime,
  readDistributionVersion,
  readRuntimeVersion,
  resolveModelRetryMaxRetries,
  resolveZCodeBaseUrl,
  withDefaultBrowserUse
} from "../src/launcher.ts";
import { classifyZaiOAuthInvocation } from "../src/zai-oauth.ts";

describe("launcher routing", () => {
  const attestation = {
    type: "zcode_runtime_attestation" as const,
    schemaVersion: 1 as const,
    executor: "zcode" as const,
    route: "odw" as const,
    runtimeId: "sess_abc",
    runtimeVersion: "0.15.2",
    sessionId: "sess_abc",
    role: "main" as const,
    parentSessionId: null,
    policySource: null,
    rolePolicy: null,
    rolePolicyFingerprint: null,
    model: "zai/glm-5.2",
    reasoningEffort: "high"
  };
  const runtime39OptionTypes = {
    ...readRuntimeCliOptionTypes(),
    "output-format": "string" as const
  };

  test("uses five runtime retries by default and preserves an explicit override", () => {
    expect(resolveModelRetryMaxRetries({})).toBe("5");
    expect(resolveModelRetryMaxRetries({ ZCODE_MODEL_RETRY_MAX_RETRIES: " 2 " })).toBe("2");
    expect(resolveModelRetryMaxRetries({ ZCODE_MODEL_RETRY_MAX_RETRIES: " " })).toBe("5");
  });

  test("translates --model into an isolated settings override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-"));
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ provider: { zai: { options: { apiKey: "secret" } } }, model: { main: "zai/old", lite: "zai/lite" } }));
      const prepared = await prepareModelOverride(
        ["--prompt", "OK", "--model", "zai/glm-5.2", "--settings", configPath],
        { HOME: directory },
      );
      expect(prepared.args).not.toContain("--settings");
      expect(prepared.args).not.toContain("--model");
      const settingsPath = join(prepared.env.HOME!, ".zcode", "cli", "config.json");
      const settings = JSON.parse(await Bun.file(settingsPath).text());
      expect(settings.model).toEqual({ main: "zai/glm-5.2", lite: "zai/lite" });
      expect(settings.provider.zai.options.apiKey).toBe("secret");
      await prepared.cleanup();
      expect(await Bun.file(settingsPath).exists()).toBe(false);
      expect(prepared.env.USERPROFILE).toBe(prepared.env.HOME);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("supports equals syntax and preserves unrelated runtime arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-equals-"));
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ model: { lite: "zai/lite" }, provider: {} }));
      const prepared = await prepareModelOverride(
        ["--prompt", "OK", "--settings=" + configPath, "--model=zai/glm-5.2", "--mode", "edit"],
        { HOME: directory },
      );
      expect(prepared.args).toEqual(["--prompt", "OK", "--mode", "edit"]);
      const settingsPath = join(prepared.env.HOME!, ".zcode", "cli", "config.json");
      const settings = JSON.parse(await Bun.file(settingsPath).text());
      expect(settings.model).toEqual({ main: "zai/glm-5.2", lite: "zai/lite" });
      await prepared.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects duplicate and missing model options", async () => {
    await expect(prepareModelOverride(["--model", "a", "--model=b"], {})).rejects.toThrow(
      "--model may be specified only once",
    );
    await expect(prepareModelOverride(["--model", "--mode", "edit"], {})).rejects.toThrow(
      "--model requires a non-empty value",
    );
  });

  test("accepts split and equals model and reasoning-effort flags and records the native route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-overrides-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      provider: { zai: { options: { apiKey: "secret" } } },
      model: { main: "zai/old", lite: "zai/lite" },
      plugins: { enabled: true, advisor: { model: "ignored" } }
    }));
    const originalHash = createHash("sha256").update(await readFile(configPath)).digest("hex");
    try {
      for (const args of [
        ["--model", "zai/glm-5.3", "--reasoning-effort", "high", "--settings", configPath],
        ["--model=zai/glm-5.3", "--reasoning-effort=high", `--settings=${configPath}`]
      ]) {
        const prepared = await prepareRuntimeOverrides(args, { HOME: directory });
        expect(prepared.requestedRoute).toEqual({
          model: "zai/glm-5.3",
          reasoningEffort: "high",
          route: "native"
        });
        expect(prepared.env.ZCODE_RUNTIME_ROUTE_OVERRIDE).toBe("1");
        expect(prepared.args).toEqual([]);
        const settingsPath = join(prepared.env.HOME!, ".zcode", "cli", "config.json");
        const settings = JSON.parse(await Bun.file(settingsPath).text());
        expect(settings.model).toMatchObject({
          main: "zai/glm-5.3",
          mainThoughtLevel: "high"
        });
        expect(settings.provider.zai.options.apiKey).toBe("secret");
        expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
        await prepared.cleanup();
        expect(await Bun.file(settingsPath).exists()).toBe(false);
        expect(await Bun.file(prepared.env.HOME!).exists()).toBe(false);
      }
      expect(createHash("sha256").update(await readFile(configPath)).digest("hex")).toBe(originalHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("marks a complete override as ODW when the protocol is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-odw-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ model: { lite: "zai/lite" } }));
    try {
      const prepared = await prepareRuntimeOverrides(
        ["--model=zai/glm-5.2", "--reasoning-effort=medium", `--settings=${configPath}`],
        { HOME: directory, ZCODE_ODW_PROTOCOL: "1" },
      );
      expect(prepared.requestedRoute?.route).toBe("odw");
      await prepared.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects incomplete, duplicate, blank, and unsafe strict overrides before preparation", async () => {
    for (const args of [
      ["--model", "zai/glm-5.2"],
      ["--reasoning-effort", "high"],
      ["--model", "a", "--model=b", "--reasoning-effort", "high"],
      ["--model", "zai/glm-5.2", "--reasoning-effort", "high", "--reasoning-effort=low"],
      ["--model", "   ", "--reasoning-effort", "high"],
      ["--model", "zai/glm-5.2", "--reasoning-effort", "   "],
      ["--model", "zai/model;rm", "--reasoning-effort", "high"],
      ["--model", "zai/glm-5.2", "--reasoning-effort", "high;rm"]
    ]) {
      await expect(prepareRuntimeOverrides(args, {})).rejects.toThrow();
    }
  });

  test("keeps the exported runtime override strict and rejects a public legacy bypass", async () => {
    await expect(prepareRuntimeOverrides(["--model", "zai/glm-5.2"], {})).rejects.toThrow(
      "--model and --reasoning-effort must be specified together",
    );
    // @ts-expect-error prepareRuntimeOverrides exposes only args and env.
    await expect(prepareRuntimeOverrides(["--model", "zai/glm-5.2"], {}, true)).rejects.toThrow(
      "--model and --reasoning-effort must be specified together",
    );
  });

  test("compatibility wrapper delegates exact overrides and preserves no-override behavior", async () => {
    const prepared = await prepareModelOverride(["--prompt", "hello"], {});
    expect(prepared).toEqual({ args: ["--prompt", "hello"], env: {}, cleanup: expect.any(Function) });
    await prepared.cleanup();
  });

  test("cleans the private directory when a protocol child stream fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-stream-failure-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ model: { lite: "zai/lite" } }));
    let preparedHome = "";
    class StreamFailureChild extends EventEmitter {
      stdout = new Readable({ read() { this.destroy(new Error("stream failure")); } });
      stderr = Readable.from([]);
      killed = false;
      kill() { this.killed = true; return true; }
    }
    try {
      const spawn = ((...args: unknown[]) => {
        const options = args[2] as { env?: NodeJS.ProcessEnv };
        preparedHome = options.env?.HOME ?? "";
        const child = new StreamFailureChild();
        queueMicrotask(() => child.emit("exit", 1, null));
        return child as never;
      }) as unknown as typeof import("node:child_process").spawn;
      await expect(runProtocolRuntime(
        "unused-node",
        ["--model=zai/glm-5.2", "--reasoning-effort=high", `--settings=${configPath}`],
        { ZCODE_ODW_PROTOCOL: "1", HOME: directory },
        spawn,
      )).rejects.toThrow("stream failure");
      expect(preparedHome).not.toBe("");
      expect(await Bun.file(preparedHome).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cleans the private directory when protocol spawn fails synchronously", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-spawn-failure-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ model: { lite: "zai/lite" } }));
    let preparedHome = "";
    try {
      const spawn = ((...args: unknown[]) => {
        const options = args[2] as { env?: NodeJS.ProcessEnv };
        preparedHome = options.env?.HOME ?? "";
        throw new Error("spawn failure");
      }) as unknown as typeof import("node:child_process").spawn;
      await expect(runProtocolRuntime(
        "unused-node",
        ["--model=zai/glm-5.2", "--reasoning-effort=high", `--settings=${configPath}`],
        { ZCODE_ODW_PROTOCOL: "1", HOME: directory },
        spawn,
      )).rejects.toThrow("spawn failure");
      expect(preparedHome).not.toBe("");
      expect(await Bun.file(preparedHome).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("supplies the official plugin API origin while preserving an explicit override", () => {
    expect(resolveZCodeBaseUrl({})).toBe("https://zcode.z.ai");
    expect(resolveZCodeBaseUrl({ ZCODE_BASE_URL: " https://example.test " })).toBe("https://example.test");
  });

  test("reads a safe npm distribution version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-version-"));
    const manifest = join(directory, "package.json");
    try {
      await writeFile(manifest, JSON.stringify({ version: "3.3.5-1" }));
      expect(readDistributionVersion(manifest)).toBe("3.3.5-1");
      await writeFile(manifest, JSON.stringify({ version: "bad\u001b[2J" }));
      expect(readDistributionVersion(manifest)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reads and labels both npm package and bundled runtime versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-version-"));
    const metadata = join(directory, "extraction.json");
    try {
      await writeFile(metadata, JSON.stringify({ cliVersion: "0.15.2" }));
      expect(readRuntimeVersion(metadata)).toBe("0.15.2");
      await writeFile(metadata, JSON.stringify({ cliVersion: "bad\u001b[2J" }));
      expect(readRuntimeVersion(metadata)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(formatVersionOutput("3.3.6-3", "0.15.2")).toBe(
      "zcode-app-cli 3.3.6-3\nzcode-runtime 0.15.2"
    );
    expect(isVersionInvocation(["version"])).toBe(true);
    expect(isVersionInvocation(["--version"])).toBe(true);
    expect(isVersionInvocation(["-v"])).toBe(true);
    expect(isVersionInvocation(["--json", "version"])).toBe(false);
  });

  test("checks configured access by default and keeps an explicit OAuth escape hatch", () => {
    expect(normalizeLoginArgs(["login"])).toEqual({
      args: ["login"],
      checkConfiguredAccess: true
    });
    expect(normalizeLoginArgs(["login", "--oauth"])).toEqual({
      args: ["login"],
      checkConfiguredAccess: false
    });
    expect(normalizeLoginArgs(["login", "--no-browser"])).toEqual({
      args: ["login", "--no-browser"],
      checkConfiguredAccess: false
    });
  });

  test("signals the first-run setup wizard only for a fresh TUI invocation", () => {
    expect(firstRunSetupEnv(true, [])).toEqual({ ZCODE_CLI_FIRST_RUN: "1" });
    expect(firstRunSetupEnv(true, ["--browser-use=headless"])).toEqual({ ZCODE_CLI_FIRST_RUN: "1" });
    expect(firstRunSetupEnv(false, [])).toBeUndefined();
    expect(firstRunSetupEnv(true, ["app-server"])).toBeUndefined();
    expect(firstRunSetupEnv(true, ["login"])).toBeUndefined();
    expect(firstRunSetupEnv(true, ["-p", "hi"])).toBeUndefined();
  });

  test("keeps setup pending across non-TUI commands until the wizard clears it", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-setup-pending-"));
    const env = { HOME: home, USERPROFILE: home };
    try {
      // First invocation creates the config via a non-TUI command (plugin list):
      // the pending marker must survive so the wizard still appears later.
      const bootstrap = await ensureUserConfig(env);
      expect(bootstrap.created).toBe(true);
      await markSetupPending(env);
      expect(await readSetupPending(env)).toBe(true);
      expect(firstRunSetupEnv(true, ["plugin", "list"])).toBeUndefined();
      expect(firstRunSetupEnv(true, ["plugin", "list"])).toBeUndefined();

      // The next interactive TUI start still triggers the wizard…
      expect(firstRunSetupEnv(await readSetupPending(env), [])).toEqual({ ZCODE_CLI_FIRST_RUN: "1" });

      // …and once the user skips or completes setup, it stops appearing.
      await clearSetupPending(env);
      expect(firstRunSetupEnv(await readSetupPending(env), [])).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("clearing setup after a successful login is reflected in the wizard trigger", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-setup-login-"));
    const env = { HOME: home, USERPROFILE: home };
    try {
      await ensureUserConfig(env);
      await markSetupPending(env);

      // `zcode login` succeeds and writes model access; the launcher then
      // clears the marker, so the next TUI start must not open the wizard.
      const configuredPath = userConfigPath(env);
      const config = JSON.parse(await readFile(configuredPath, "utf8")) as {
        provider?: { zai?: { options?: { apiKey?: string } } };
      };
      config.provider!.zai!.options!.apiKey = "login-written-key";
      await writeFile(configuredPath, JSON.stringify(config));
      expect(await readConfiguredModelAccess(env)).not.toBeNull();

      await clearSetupPending(env);
      expect(firstRunSetupEnv(await readSetupPending(env), [])).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("enables Browser Use only for agent-producing runtime invocations", () => {
    expect(withDefaultBrowserUse([])).toEqual(["--browser-use=headless"]);
    expect(withDefaultBrowserUse(["tui"])).toEqual(["--browser-use=headless", "tui"]);
    expect(withDefaultBrowserUse(["--cwd", "/tmp/project", "--continue"])).toEqual([
      "--browser-use=headless",
      "--cwd",
      "/tmp/project",
      "--continue"
    ]);
    expect(withDefaultBrowserUse(["--prompt", "inspect this page"])).toEqual([
      "--browser-use=headless",
      "--prompt",
      "inspect this page"
    ]);
    expect(withDefaultBrowserUse([
      "--output-format",
      "json",
      "--surface",
      "terminal",
      "--prompt",
      "inspect this page"
    ], runtime39OptionTypes)).toEqual([
      "--browser-use=headless",
      "--output-format",
      "json",
      "--surface",
      "terminal",
      "--prompt",
      "inspect this page"
    ]);
    expect(withDefaultBrowserUse(["--target=verify the site"])).toEqual([
      "--browser-use=headless",
      "--target=verify the site"
    ]);
    expect(withDefaultBrowserUse(["--print", "inspect this page"])).toEqual([
      "--browser-use=headless",
      "--print",
      "inspect this page"
    ]);
    expect(withDefaultBrowserUse(["--browser-executable", "/opt/chrome", "tui"])).toEqual([
      "--browser-use=headless",
      "--browser-executable",
      "/opt/chrome",
      "tui"
    ]);
  });

  test("preserves explicit Browser Use and never injects it into management commands", () => {
    const explicit = ["--browser-use", "headless", "tui"];
    expect(withDefaultBrowserUse(explicit)).toBe(explicit);
    for (const args of [
      ["plugins", "list", "--json"],
      ["--settings", "custom.json", "plugins", "list"],
      ["skills", "list"],
      ["doctor"],
      ["app-server"],
      ["login"],
      ["commands", "list"],
      ["--surface", "terminal", "tui"],
      ["--settings", "custom.json", "--prompt", "inspect this page"],
      ["--help"],
      ["--version"],
      ["--unknown"]
    ]) {
      expect(withDefaultBrowserUse(args)).toBe(args);
    }
  });

  test("recognizes TUI invocations after consuming global option values", () => {
    expect(isTuiRuntimeInvocation([])).toBe(true);
    expect(isTuiRuntimeInvocation(["--cwd", "/tmp/project", "--mode", "plan", "tui"])).toBe(true);
    expect(isTuiRuntimeInvocation(["--output-format", "json", "tui"], runtime39OptionTypes)).toBe(true);
    expect(isTuiRuntimeInvocation(["--browser-use", "headless", "--cwd", "/tmp/project", "tui"])).toBe(true);
    expect(isTuiRuntimeInvocation(["--surface", "terminal", "tui"])).toBe(false);
    expect(isTuiRuntimeInvocation(["--prompt", "inspect this page"])).toBe(false);
    expect(isTuiRuntimeInvocation(["plugins", "list"])).toBe(false);
    expect(isTuiRuntimeInvocation(["--help"])).toBe(false);
    expect(isTuiRuntimeInvocation(["--unknown"])).toBe(false);
  });

  test("routes only the plain Z.AI login command through the Desktop OAuth bridge", () => {
    expect(classifyZaiOAuthInvocation(["login"])).toEqual({
      json: false,
      noBrowser: false,
      runtimeArgs: ["login"]
    });
    expect(classifyZaiOAuthInvocation(["login", "--oauth", "--no-browser"])).toEqual({
      json: false,
      noBrowser: true,
      runtimeArgs: ["login", "--no-browser"]
    });
    expect(classifyZaiOAuthInvocation(["--json", "login", "--oauth"])).toEqual({
      json: true,
      noBrowser: false,
      runtimeArgs: ["--json", "login"]
    });
    expect(classifyZaiOAuthInvocation(["login", "zai-coding-plan-api-key", "secret"])).toBeNull();
    expect(classifyZaiOAuthInvocation(["login", "--unknown"])).toBeNull();
  });

  test("extractUsageFooter parses the trailing zcode_usage line and strips it from stderr", () => {
    // The patched runtime appends a usage footer as the last stderr line under ODW protocol.
    // patched 运行时在 ODW 协议下把 usage 尾行作为 stderr 最后一行追加。
    const stderr = [
      "some warning chatter",
      'error: transient blip',
      '{"type":"zcode_usage","sessionId":"sess_abc","totalTokens":1234,"inputTokens":1000,"outputTokens":234}',
      ""
    ].join("\n");
    const { footer, cleanStderr } = extractUsageFooter(stderr);
    expect(footer).not.toBeNull();
    expect(footer?.type).toBe("zcode_usage");
    expect(footer?.sessionId).toBe("sess_abc");
    expect(footer?.totalTokens).toBe(1234);
    expect(footer?.inputTokens).toBe(1000);
    expect(footer?.outputTokens).toBe(234);
    // The footer line is removed; other stderr stays for diagnostics.
    // footer 行被移除；其余 stderr 保留以便排查。
    expect(cleanStderr).not.toContain("zcode_usage");
    expect(cleanStderr).toContain("some warning chatter");
    expect(cleanStderr).toContain("error: transient blip");
  });

  test("extractUsageFooter returns a null footer and unchanged stderr when no footer is present", () => {
    // Unpatched runtime, or a run that died before emitting the footer → no telemetry, stderr intact.
    // 未打补丁的运行时，或在输出 footer 前死掉的运行 → 无遥测，stderr 原样保留。
    const stderr = "just ordinary stderr\nwith two lines";
    const { footer, cleanStderr } = extractUsageFooter(stderr);
    expect(footer).toBeNull();
    expect(cleanStderr).toBe(stderr);
  });

  test("extractUsageFooter ignores a malformed footer line (never throws)", () => {
    const stderr = 'warning\n{"type":"zcode_usage",not valid json}\n';
    const { footer, cleanStderr } = extractUsageFooter(stderr);
    expect(footer).toBeNull();
    // The malformed line is left in stderr (we only strip a line we successfully parsed).
    // 畸形行保留在 stderr 中（只剥离成功解析的行）。
    expect(cleanStderr).toContain("not valid json");
  });

  test("extractRuntimeAttestation accepts one valid footer and strips only that line", () => {
    const stderr = [
      "warning",
      JSON.stringify(attestation),
      '{"type":"zcode_usage","sessionId":"sess_abc","totalTokens":12}',
      ""
    ].join("\n");
    const parsed = extractRuntimeAttestation(stderr);
    expect(parsed.attestation).toEqual(attestation);
    expect(parsed.cleanStderr).toContain("warning");
    expect(parsed.cleanStderr).toContain("zcode_usage");
    expect(parsed.cleanStderr).not.toContain("zcode_runtime_attestation");
  });

  test("extractRuntimeAttestation rejects missing, duplicate, malformed, invalid, and mismatched footers", () => {
    expect(extractRuntimeAttestation("warning").attestation).toBeNull();
    expect(() => extractRuntimeAttestation(
      `${JSON.stringify(attestation)}\n${JSON.stringify(attestation)}`
    )).toThrow("duplicate");
    expect(() => extractRuntimeAttestation('{"type":"zcode_runtime_attestation",')).toThrow();
    expect(() => extractRuntimeAttestation(JSON.stringify({ ...attestation, model: "" }))).toThrow();
    expect(() => extractRuntimeAttestation(JSON.stringify({ ...attestation, executor: "other" }))).toThrow();
    expect(() => extractRuntimeAttestation(JSON.stringify({ ...attestation, rolePolicyFingerprint: "bad" }))).toThrow();
    expect(() => extractRuntimeAttestation(JSON.stringify(attestation), {
      model: "zai/other",
      reasoningEffort: "high",
      route: "odw"
    })).toThrow("mismatch");
  });
});
