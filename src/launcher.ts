import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearSetupPending,
  ensureUserConfig,
  markSetupPending,
  readConfiguredModelAccess,
  readSetupPending,
  userConfigPath
} from "./model-access.ts";
import {
  classifyZaiOAuthInvocation,
  runZaiOAuthLogin,
  type OfficialLoginPayload
} from "./zai-oauth.ts";
import { requestAppServer } from "./app-server-client.ts";
import { runPluginCommand } from "./plugin-cli.ts";
import { missingCodingPlanKey } from "./prompt-preflight.ts";
import {
  capabilitiesFromExtractionMetadata,
  type RuntimeCliOptionType
} from "./runtime-capabilities.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = join(packageRoot, "package.json");
const extractionMetadataPath = join(packageRoot, "vendor", "extraction.json");
const runtimePath = join(packageRoot, "vendor", "zcode.cjs");
const launcherPath = join(packageRoot, "bin", "zcode.js");
const defaultZCodeBaseUrl = "https://zcode.z.ai";
const defaultModelRetryMaxRetries = "5";
const defaultBrowserUseArgument = "--browser-use=headless";
const tuiRuntimeLogLimitBytes = 2 * 1024 * 1024;
const versionArguments = new Set(["version", "--version", "-v"]);
const runtimeVariadicOptions = new Set(["--disallowedTools", "--disallowed-tools"]);
const fallbackRuntimeOptionTypes: Readonly<Record<string, RuntimeCliOptionType>> = {
  attach: "string",
  "browser-executable": "string",
  "browser-use": "string",
  continue: "boolean",
  cwd: "string",
  force: "boolean",
  "force-mcs": "boolean",
  help: "boolean",
  json: "boolean",
  locale: "string",
  mode: "string",
  "no-browser": "boolean",
  "no-color": "boolean",
  "output-format": "string",
  prompt: "string",
  resume: "string",
  stdio: "boolean",
  surface: "string",
  target: "string",
  "target-replace": "boolean",
  verbose: "boolean",
  version: "boolean"
};

export function resolveModelRetryMaxRetries(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_MODEL_RETRY_MAX_RETRIES?.trim() || defaultModelRetryMaxRetries;
}

export function resolveZCodeBaseUrl(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_BASE_URL?.trim() || defaultZCodeBaseUrl;
}

export function resolveNodeExecutable(): string {
  return process.env.ZCODE_NODE?.trim() || process.execPath;
}

function safeVersion(value: unknown): string | undefined {
  const version = typeof value === "string" ? value.trim() : "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(version) ? version : undefined;
}

function readJsonVersion(path: string, key: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return safeVersion(value[key]);
  } catch {
    return undefined;
  }
}

export function readRuntimeCliOptionTypes(
  metadataPath = extractionMetadataPath
): Readonly<Record<string, RuntimeCliOptionType>> {
  try {
    const metadata: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
    const capabilities = capabilitiesFromExtractionMetadata(metadata);
    if (!capabilities) return fallbackRuntimeOptionTypes;
    return Object.fromEntries(
      Object.entries(capabilities.cli.globalOptions).map(([name, option]) => [name, option.type])
    );
  } catch {
    return fallbackRuntimeOptionTypes;
  }
}

export function readDistributionVersion(manifestPath = packageManifestPath): string | undefined {
  return readJsonVersion(manifestPath, "version");
}

export function readRuntimeVersion(metadataPath = extractionMetadataPath): string | undefined {
  return readJsonVersion(metadataPath, "cliVersion");
}

export function isVersionInvocation(args: string[]): boolean {
  return args.length === 1 && versionArguments.has(args[0]!);
}

export function formatVersionOutput(distributionVersion: string, runtimeVersion: string): string {
  return [
    `zcode-app-cli ${safeVersion(distributionVersion) ?? "unknown"}`,
    `zcode-runtime ${safeVersion(runtimeVersion) ?? "unknown"}`
  ].join("\n");
}

export function normalizeLoginArgs(args: string[]): { args: string[]; checkConfiguredAccess: boolean } {
  if (args.length === 1 && args[0] === "login") {
    return { args, checkConfiguredAccess: true };
  }
  if (args[0] === "login" && args.includes("--oauth")) {
    return { args: args.filter((argument) => argument !== "--oauth"), checkConfiguredAccess: false };
  }
  return { args, checkConfiguredAccess: false };
}

function longOptionName(argument: string): string {
  const separator = argument.indexOf("=");
  return separator < 0 ? argument : argument.slice(0, separator);
}

interface RuntimeInvocationInspection {
  agentInvocation: boolean;
  command?: string;
  explicitBrowserUse: boolean;
  invalid: boolean;
  passthrough: boolean;
  workingDirectory?: string;
  resume: boolean;
}

function inspectRuntimeInvocation(
  args: string[],
  runtimeOptionTypes: Readonly<Record<string, RuntimeCliOptionType>>
): RuntimeInvocationInspection {
  let agentInvocation = false;
  let command: string | undefined;
  let explicitBrowserUse = false;
  let invalid = false;
  let passthrough = false;
  let presentationSurface = false;
  let workingDirectory: string | undefined;
  let resume = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      command ??= args[index + 1];
      break;
    }
    if (argument.startsWith("--")) {
      const option = longOptionName(argument);
      const inlineValue = option.length !== argument.length;
      if (option === "--cwd") workingDirectory = inlineValue
        ? argument.slice(option.length + 1) : args[index + 1];
      if (option === "--resume" || option === "--continue") resume = true;
      if (option === "--browser-use") {
        explicitBrowserUse = true;
        if (!inlineValue) {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (option === "--help" || option === "--version") {
        passthrough = true;
        continue;
      }
      if (option === "--print") {
        if (inlineValue) invalid = true;
        else agentInvocation = true;
        continue;
      }
      if (option === "--prompt" || option === "--target") {
        agentInvocation = true;
        if (!inlineValue) {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (runtimeVariadicOptions.has(option)) {
        if (!inlineValue) {
          const firstValue = index + 1;
          while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) index += 1;
          if (index < firstValue) invalid = true;
        }
        continue;
      }
      const runtimeOptionType = runtimeOptionTypes[option.slice(2)];
      if (runtimeOptionType === "string") {
        presentationSurface ||= option === "--surface";
        if (!inlineValue) {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (runtimeOptionType === "boolean" && !inlineValue) continue;
      invalid = true;
      continue;
    }
    if (argument.startsWith("-")) {
      if (argument === "-h" || argument === "-v") {
        passthrough = true;
        continue;
      }
      if (argument === "-p" || argument.startsWith("-p")) {
        agentInvocation = true;
        if (argument === "-p") {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (argument === "-c" || argument === "-f") {
        if (argument === "-c") resume = true;
        continue;
      }
      invalid = true;
      continue;
    }
    command ??= argument;
  }

  if (presentationSurface
    && !agentInvocation
    && command !== "app-server"
    && command !== "agent-server") invalid = true;

  return { agentInvocation, command, explicitBrowserUse, invalid, passthrough, workingDirectory, resume };
}

export async function promptPreflight(
  args: string[], env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  const invocation = inspectRuntimeInvocation(args, readRuntimeCliOptionTypes());
  if (!invocation.agentInvocation || invocation.invalid || invocation.passthrough || invocation.resume) {
    return undefined;
  }
  return missingCodingPlanKey({ env, workingDirectory: invocation.workingDirectory });
}

export function withDefaultBrowserUse(
  args: string[],
  runtimeOptionTypes = readRuntimeCliOptionTypes()
): string[] {
  const invocation = inspectRuntimeInvocation(args, runtimeOptionTypes);
  if (invocation.explicitBrowserUse
    || invocation.passthrough
    || invocation.invalid
    || (!invocation.agentInvocation
      && invocation.command !== undefined
      && invocation.command !== "tui")) return args;
  return [defaultBrowserUseArgument, ...args];
}

export function isTuiRuntimeInvocation(
  args: string[],
  runtimeOptionTypes = readRuntimeCliOptionTypes()
): boolean {
  const invocation = inspectRuntimeInvocation(args, runtimeOptionTypes);
  return !invocation.agentInvocation
    && !invocation.invalid
    && !invocation.passthrough
    && (invocation.command === undefined || invocation.command === "tui");
}

export function firstRunSetupEnv(setupPending: boolean, args: string[]): NodeJS.ProcessEnv | undefined {
  if (!setupPending || !isTuiRuntimeInvocation(args)) return undefined;
  return { ZCODE_CLI_FIRST_RUN: "1" };
}

function runtimeEnvironment(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ZCODE_CLI_OAUTH_CALLBACK_STDIN;
  const distributionVersion = readDistributionVersion();
  const inherited: NodeJS.ProcessEnv = {
    ...env,
    ...extra
  };
  const merged: NodeJS.ProcessEnv = {
    ...inherited,
    ZCODE_BASE_URL: resolveZCodeBaseUrl(inherited),
    ZCODE_MODEL_RETRY_MAX_RETRIES: resolveModelRetryMaxRetries(inherited),
    ZCODE_APP_CLI_EXECUTABLE: process.execPath,
    ZCODE_APP_CLI_ENTRY: launcherPath,
    ...(distributionVersion ? { ZCODE_APP_CLI_VERSION: distributionVersion } : {}),
    ...(readRuntimeVersion() ? { ZCODE_RUNTIME_VERSION: readRuntimeVersion() } : {})
  };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = (osConstants.signals as Record<string, number>)[signal];
  return typeof number === "number" ? 128 + number : 1;
}

async function waitForChild(
  child: ChildProcess,
  onError: (error: Error) => void = (error) => console.error("Error: " + error.message)
): Promise<number> {
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("error", (error) => {
      onError(error);
      finish(1);
    });
    child.once("exit", (code, signal) => finish(code ?? signalExitCode(signal)));
  });
}

interface TuiRuntimeDiagnosticState {
  bytes: number;
  initialized: boolean;
  path?: string;
  writeFailed: boolean;
}

function appendTuiRuntimeDiagnostic(chunk: Buffer | string, state: TuiRuntimeDiagnosticState): void {
  if (state.bytes >= tuiRuntimeLogLimitBytes) return;
  const text = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  try {
    const path = state.path ?? (process.env.ZCODE_TUI_RUNTIME_LOG?.trim()
      || join(homedir(), ".zcode", "cli", "tui-runtime.log"));
    state.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!state.initialized) {
      state.initialized = true;
      const existingBytes = existsSync(path) ? statSync(path).size : 0;
      if (existingBytes >= tuiRuntimeLogLimitBytes) {
        const rotated = `${path}.1`;
        if (existsSync(rotated)) unlinkSync(rotated);
        renameSync(path, rotated);
        chmodSync(rotated, 0o600);
      } else {
        state.bytes = existingBytes;
      }
    }
    const bounded = text.subarray(0, tuiRuntimeLogLimitBytes - state.bytes);
    if (bounded.byteLength === 0) return;
    appendFileSync(path, bounded, { mode: 0o600 });
    chmodSync(path, 0o600);
    state.bytes += bounded.byteLength;
  } catch {
    state.writeFailed = true;
  }
}

function tuiRuntimeFailureMessage(code: number, state: TuiRuntimeDiagnosticState): string {
  const diagnostic = state.path && !state.writeFailed
    ? ` Diagnostics: ${state.path}`
    : " Runtime diagnostics could not be written.";
  return `Error: ZCode runtime exited with status ${code}.${diagnostic}\n`;
}

export const defaultModel = "zai/glm-5.2";

interface ParsedOption {
  value: string;
  indexes: number[];
}

export type RuntimeRoute = {
  model: string;
  reasoningEffort: string;
  route: "native" | "odw";
};

export type RuntimeOverrides = {
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
  requestedRoute?: RuntimeRoute;
};

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;
const effortPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function parseOption(args: string[], name: string): ParsedOption | undefined {
  const matches: ParsedOption[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a non-empty value`);
      }
      matches.push({ value, indexes: [index, index + 1] });
      index += 1;
      continue;
    }
    if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a non-empty value`);
      matches.push({ value, indexes: [index] });
    }
  }
  if (matches.length > 1) throw new Error(`${name} may be specified only once`);
  return matches[0];
}

async function prepareRuntimeOverridesInternal(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  allowLegacyModelOnly = false,
): Promise<RuntimeOverrides> {
  const modelOption = parseOption(args, "--model");
  const effortOption = parseOption(args, "--reasoning-effort");
  if ((modelOption === undefined) !== (effortOption === undefined)
    && !(allowLegacyModelOnly && modelOption !== undefined && effortOption === undefined)) {
    throw new Error("--model and --reasoning-effort must be specified together");
  }
  if (modelOption === undefined) {
    return { args, env: {}, cleanup: async () => {} };
  }
  const settingsOption = parseOption(args, "--settings");
  const model = modelOption.value.trim();
  if (!model || !modelPattern.test(model)) {
    throw new Error("--model requires a safe provider/model identifier");
  }
  const reasoningEffort = effortOption?.value.trim();
  if (reasoningEffort !== undefined && (!reasoningEffort || !effortPattern.test(reasoningEffort))) {
    throw new Error("--reasoning-effort requires a safe token");
  }
  const sourcePath = settingsOption?.value ?? userConfigPath(env);
  const config = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
  const modelConfig = config.model && typeof config.model === "object" && !Array.isArray(config.model)
    ? { ...(config.model as Record<string, unknown>) }
    : {};
  modelConfig.main = model;
  if (reasoningEffort !== undefined) modelConfig.mainThoughtLevel = reasoningEffort;
  config.model = modelConfig;
  const directory = await mkdtemp(join(tmpdir(), "zcode-settings-"));
  try {
    await chmod(directory, 0o700);
    const configPath = join(directory, ".zcode", "cli", "config.json");
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const removedIndexes = new Set([
    ...modelOption.indexes,
    ...(effortOption?.indexes ?? []),
    ...(settingsOption?.indexes ?? [])
  ]);
  const runtimeArgs = args.filter((_, index) => !removedIndexes.has(index));
  return {
    args: runtimeArgs,
    env: { HOME: directory, USERPROFILE: directory, ZCODE_RUNTIME_ROUTE_OVERRIDE: "1" },
    cleanup: async () => rm(directory, { recursive: true, force: true }),
    ...(reasoningEffort !== undefined ? {
      requestedRoute: {
        model,
        reasoningEffort,
        route: env.ZCODE_ODW_PROTOCOL === "1" ? "odw" : "native"
      }
    } : {})
  };
}

export async function prepareRuntimeOverrides(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeOverrides> {
  return prepareRuntimeOverridesInternal(args, env);
}

export async function prepareModelOverride(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const prepared = await prepareRuntimeOverridesInternal(args, env, true);
  return { args: prepared.args, env: prepared.env, cleanup: prepared.cleanup };
}

export interface ZcodeRuntimeAttestation {
  type: "zcode_runtime_attestation";
  schemaVersion: 1;
  executor: "zcode";
  route: "native" | "odw";
  runtimeId: string;
  runtimeVersion: string;
  sessionId: string;
  role: "main" | "lite";
  parentSessionId: string | null;
  policySource: "new" | "persisted" | "parent" | null;
  rolePolicy: {
    advisorModel: string;
    advisorEffort: string;
    gruntModel: string;
    gruntEffort: string;
  } | null;
  rolePolicyFingerprint: string | null;
  model: string;
  reasoningEffort: string;
}

export interface ODWResultEnvelope {
  type: "zcode_result";
  text: string;
  stderr: string;
  exitCode: number;
  sessionId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Total tokens (input+output+reasoning) when the runtime reports it; null when unavailable. */
  /** 运行时报出的总 token（input+output+reasoning）；不可用时为 null。 */
  totalTokens: number | null;
  telemetryAvailable: boolean;
  runtimeAttestation: ZcodeRuntimeAttestation | null;
}

/**
 * The structured usage footer the patched runtime writes to stderr when ZCODE_ODW_PROTOCOL=1
 * (injected by patchRuntimeUsageFooter during sync-runtime). Carries the session ID and token
 * totals that the envelope otherwise has no way to recover — the runtime generates the session ID
 * internally and never prints it in prompt mode, so without this footer the launcher cannot map a
 * run to its model_usage rows.
 *
 * 经 patched 运行时在 ZCODE_ODW_PROTOCOL=1 时写到 stderr 的结构化 usage 尾行（由 sync-runtime 期间
 * 的 patchRuntimeUsageFooter 注入）。携带信封本无法取回的 session ID 与 token 总数——运行时在内部
 * 生成 session ID，prompt 模式下从不打印它，因此没有这条尾行，launcher 无法把一次运行映射到它的
 * model_usage 行。
 */
interface ZcodeUsageFooter {
  type: "zcode_usage";
  sessionId?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rolePolicyFingerprint(policy: NonNullable<ZcodeRuntimeAttestation["rolePolicy"]>): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function validateRuntimeAttestation(value: unknown): ZcodeRuntimeAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ZCode runtime attestation schema");
  }
  const candidate = value as Record<string, unknown>;
  const requiredStrings = ["runtimeId", "runtimeVersion", "sessionId", "model", "reasoningEffort"];
  if (candidate.type !== "zcode_runtime_attestation"
    || candidate.schemaVersion !== 1
    || candidate.executor !== "zcode"
    || (candidate.route !== "native" && candidate.route !== "odw")
    || (candidate.role !== "main" && candidate.role !== "lite")
    || !requiredStrings.every((key) => isNonEmptyString(candidate[key]))) {
    throw new Error("Invalid ZCode runtime attestation schema");
  }
  if (candidate.parentSessionId !== null && !isNonEmptyString(candidate.parentSessionId)) {
    throw new Error("Invalid ZCode runtime attestation parentSessionId");
  }
  const policySource = candidate.policySource;
  if (policySource !== null && policySource !== "new" && policySource !== "persisted" && policySource !== "parent") {
    throw new Error("Invalid ZCode runtime attestation policySource");
  }
  const policy = candidate.rolePolicy;
  let rolePolicy: ZcodeRuntimeAttestation["rolePolicy"] = null;
  if (policy !== null) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error("Invalid ZCode runtime attestation rolePolicy");
    }
    const record = policy as Record<string, unknown>;
    if (!["advisorModel", "advisorEffort", "gruntModel", "gruntEffort"].every((key) => isNonEmptyString(record[key]))) {
      throw new Error("Invalid ZCode runtime attestation rolePolicy");
    }
    rolePolicy = {
      advisorModel: record.advisorModel as string,
      advisorEffort: record.advisorEffort as string,
      gruntModel: record.gruntModel as string,
      gruntEffort: record.gruntEffort as string
    };
  }
  if (candidate.rolePolicyFingerprint !== null
    && (!/^[a-f0-9]{64}$/u.test(String(candidate.rolePolicyFingerprint)) || !rolePolicy
      || candidate.rolePolicyFingerprint !== rolePolicyFingerprint(rolePolicy))) {
    throw new Error("Invalid ZCode runtime attestation rolePolicyFingerprint");
  }
  if ((rolePolicy !== null) !== (candidate.rolePolicyFingerprint !== null)
    || (rolePolicy !== null && policySource === null)) {
    throw new Error("Invalid ZCode runtime attestation policy fields");
  }
  if ((candidate.route === "odw" || rolePolicy === null)
    && (candidate.policySource !== null || rolePolicy !== null || candidate.rolePolicyFingerprint !== null)) {
    throw new Error("Invalid ZCode runtime attestation policy fields");
  }
  if (candidate.route === "odw" && (candidate.role !== "main" || candidate.parentSessionId !== null)) {
    throw new Error("Invalid ZCode ODW runtime attestation role");
  }
  return {
    type: "zcode_runtime_attestation",
    schemaVersion: 1,
    executor: "zcode",
    route: candidate.route as ZcodeRuntimeAttestation["route"],
    runtimeId: candidate.runtimeId as string,
    runtimeVersion: candidate.runtimeVersion as string,
    sessionId: candidate.sessionId as string,
    role: candidate.role as ZcodeRuntimeAttestation["role"],
    parentSessionId: candidate.parentSessionId as string | null,
    policySource: policySource as ZcodeRuntimeAttestation["policySource"],
    rolePolicy,
    rolePolicyFingerprint: candidate.rolePolicyFingerprint as string | null,
    model: candidate.model as string,
    reasoningEffort: candidate.reasoningEffort as string
  };
}

export function extractRuntimeAttestation(
  stderr: string,
  requested?: RuntimeRoute,
): { attestation: ZcodeRuntimeAttestation | null; cleanStderr: string } {
  const lines = stderr.split("\n");
  const indexes = lines.reduce<number[]>((found, line, index) => {
    if (line.includes("zcode_runtime_attestation")) found.push(index);
    return found;
  }, []);
  if (indexes.length > 1) throw new Error("duplicate ZCode runtime attestation footer");
  if (indexes.length === 0) return { attestation: null, cleanStderr: stderr };
  const index = indexes[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[index]!.trim());
  } catch {
    throw new Error("Malformed ZCode runtime attestation footer");
  }
  const attestation = validateRuntimeAttestation(parsed);
  if (requested && (attestation.route !== requested.route
    || attestation.model !== requested.model
    || attestation.reasoningEffort !== requested.reasoningEffort)) {
    throw new Error("ZCode runtime attestation mismatch");
  }
  return {
    attestation,
    cleanStderr: lines.slice(0, index).concat(lines.slice(index + 1)).join("\n").replace(/\n$/, "")
  };
}

/**
 * Scan stderr for the trailing `{"type":"zcode_usage",...}` footer the patched runtime emits,
 * parse it, and return both the parsed footer and the stderr with that line stripped (so the
 * launcher's envelope.stderr stays clean for diagnostics). Returns null footer when absent — the
 * runtime may be an unpatched build, or the run errored before the footer was written. Never
 * throws: a malformed footer line is ignored (treated as not present).
 *
 * 扫描 stderr，寻找 patched 运行时输出的尾部 `{"type":"zcode_usage",...}` 尾行，解析它，并返回
 * 解析后的 footer 以及去掉该行后的 stderr（使 launcher 信封的 stderr 保持干净以便排查）。缺省时
 * 返回 null footer——运行时可能是未打补丁的构建，或在写出 footer 前就出错了。绝不抛出：畸形的
 * footer 行被忽略（视为不存在）。
 */
export function extractUsageFooter(stderr: string): { footer: ZcodeUsageFooter | null; cleanStderr: string } {
  const lines = stderr.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.includes("zcode_usage")) continue;
    try {
      const parsed = JSON.parse(line) as ZcodeUsageFooter;
      if (parsed && parsed.type === "zcode_usage") {
        const remaining = lines.slice(0, i).concat(lines.slice(i + 1)).join("\n").replace(/\n$/, "");
        return { footer: parsed, cleanStderr: remaining };
      }
    } catch {
      // malformed footer line — ignore, keep scanning
      // 畸形 footer 行 —— 忽略，继续向上扫描
    }
  }
  return { footer: null, cleanStderr: stderr };
}

async function readChildText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runProtocolRuntime(
  node: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  spawnRuntime: typeof spawnChild = spawnChild,
): Promise<number> {
  const prepared = await prepareRuntimeOverrides(args, { ...process.env, ...extraEnv });
  let child: ChildProcess;
  try {
    child = spawnRuntime(node, [runtimePath, ...prepared.args], {
      cwd: process.cwd(),
      env: runtimeEnvironment({ ...extraEnv, ...prepared.env }),
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
  // Bug E: forward termination signals to the runtime child, mirroring runRuntime. Without this,
  // running `zcode --prompt ... ` with ZCODE_ODW_PROTOCOL=1 DIRECTLY (not via ODW) and pressing
  // Ctrl-C would kill the launcher but orphan the runtime child, which keeps running (editing files,
  // making API calls). Via ODW the process-group SIGKILL already covers this; this protects direct use.
  // Bug E：把终止信号转发给运行时子进程，与 runRuntime 一致。没有它，直接（非经 ODW）运行
  // `zcode --prompt ... ` + ZCODE_ODW_PROTOCOL=1 并按 Ctrl-C 会杀掉 launcher 但留下孤儿的运行时子进程，
  // 后者继续运行（改文件、发 API）。经 ODW 时进程组 SIGKILL 已覆盖此场景；这里保护的是直接使用。
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const onSighup = () => forwardSignal("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.once("SIGHUP", onSighup);
  try {
    const [stdout, stderr, code] = await Promise.all([
      readChildText(child.stdout),
      readChildText(child.stderr),
      waitForChild(child)
    ]);
    // Bug 5: the patched runtime appends a `{"type":"zcode_usage",...}` footer to stderr under
    // ZCODE_ODW_PROTOCOL=1, carrying the session ID and token totals the envelope has no other way
    // to recover. Strip it from the displayed stderr and fold its fields into the envelope. When the
    // footer is absent (unpatched runtime, or a run that died before emitting it), telemetry stays
    // null and telemetryAvailable stays false — the ODW reducer tolerates both.
    // Bug 5：patched 运行时在 ZCODE_ODW_PROTOCOL=1 下向 stderr 追加一条 `{"type":"zcode_usage",...}`
    // 尾行，携带信封本无法取回的 session ID 与 token 总数。把它从展示用的 stderr 里剥离，并将其
    // 字段折入信封。尾行缺失时（未打补丁的运行时，或在输出前就死掉的运行），遥测保持 null、
    // telemetryAvailable 保持 false——ODW reducer 两种情况都容忍。
    const { attestation, cleanStderr: attestationStderr } = extractRuntimeAttestation(
      stderr,
      prepared.requestedRoute,
    );
    if (prepared.requestedRoute && !attestation) {
      throw new Error("Missing ZCode runtime attestation footer");
    }
    const { footer, cleanStderr } = extractUsageFooter(attestationStderr);
    const toFinite = (value: number | undefined): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const envelope: ODWResultEnvelope = {
      type: "zcode_result",
      text: stdout.trimEnd(),
      stderr: cleanStderr.trimEnd(),
      exitCode: code,
      sessionId: footer?.sessionId ?? null,
      costUsd: null,
      inputTokens: toFinite(footer?.inputTokens),
      outputTokens: toFinite(footer?.outputTokens),
      totalTokens: toFinite(footer?.totalTokens),
      telemetryAvailable: footer !== null,
      runtimeAttestation: attestation
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return code;
  } finally {
    // Bug D: cleanup MUST run even if Promise.all throws (a stream error mid-read) — otherwise the
    // --model temp settings dir leaks in /tmp on every such failure. Mirrors runRuntime's finally.
    // Bug D：即使 Promise.all 抛出（读流中途出错），cleanup 也必须执行——否则每次此类失败都会在
    // /tmp 泄漏一个 --model 的临时 settings 目录。与 runRuntime 的 finally 一致。
    await prepared.cleanup();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (process.platform !== "win32") process.off("SIGHUP", onSighup);
  }
}

async function runRuntime(
  node: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<number> {
  if (process.env.ZCODE_ODW_PROTOCOL === "1") {
    return runProtocolRuntime(node, args, extraEnv);
  }
  const tuiInvocation = isTuiRuntimeInvocation(args);
  const prepared = await prepareRuntimeOverrides(args, { ...process.env, ...extraEnv });
  let child: ChildProcess;
  try {
    child = spawnChild(node, [runtimePath, ...prepared.args], {
      cwd: process.cwd(),
      env: runtimeEnvironment({ ...extraEnv, ...prepared.env }),
      stdio: tuiInvocation ? ["inherit", "inherit", "pipe"] : "inherit"
    });
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
  const diagnosticState: TuiRuntimeDiagnosticState = {
    bytes: 0,
    initialized: false,
    writeFailed: false
  };
  const onDiagnostic = (chunk: Buffer | string) => appendTuiRuntimeDiagnostic(chunk, diagnosticState);
  child.stderr?.on("data", onDiagnostic);
  let forwardedSignal = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    forwardedSignal = true;
    if (!child.killed) child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const onSighup = () => forwardSignal("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.once("SIGHUP", onSighup);
  try {
    const code = await waitForChild(
      child,
      tuiInvocation
        ? (error) => appendTuiRuntimeDiagnostic((error.stack ?? error.message) + "\n", diagnosticState)
        : undefined
    );
    if (tuiInvocation && code !== 0 && !forwardedSignal) {
      process.stderr.write(tuiRuntimeFailureMessage(code, diagnosticState));
    }
    return code;
  } finally {
    child.stderr?.off("data", onDiagnostic);
    await prepared.cleanup();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (process.platform !== "win32") process.off("SIGHUP", onSighup);
  }
}

async function completeOfficialZaiLogin(
  node: string,
  payload: OfficialLoginPayload,
  runtimeArgs: string[],
  abortSignal: AbortSignal
): Promise<number> {
  if (abortSignal.aborted) return 130;
  const child = spawnChild(node, [runtimePath, ...runtimeArgs], {
    cwd: process.cwd(),
    env: runtimeEnvironment({ ZCODE_CLI_OAUTH_CALLBACK_STDIN: "1" }),
    stdio: ["pipe", "inherit", "inherit"]
  });
  const onAbort = () => child.kill("SIGINT");
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    child.stdin?.end(JSON.stringify(payload));
    return await waitForChild(child);
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}

export async function main(args: string[]): Promise<number> {
  if (!existsSync(runtimePath)) {
    console.error(
      "ZCode runtime is missing. Reinstall the package or run `bun run sync:local` in the source checkout."
    );
    return 1;
  }

  if (isVersionInvocation(args)) {
    const distributionVersion = readDistributionVersion();
    const runtimeVersion = readRuntimeVersion();
    if (!distributionVersion || !runtimeVersion) {
      console.error("Unable to read npm package or bundled runtime version metadata.");
      return 1;
    }
    console.log(formatVersionOutput(distributionVersion, runtimeVersion));
    return 0;
  }

  let setupPending = false;
  try {
    const bootstrap = await ensureUserConfig();
    if (bootstrap.created) {
      await markSetupPending();
      setupPending = true;
    } else {
      setupPending = await readSetupPending();
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const node = resolveNodeExecutable();
  const pluginAbortController = new AbortController();
  const cancelPluginCommand = () => pluginAbortController.abort();
  process.once("SIGINT", cancelPluginCommand);
  process.once("SIGTERM", cancelPluginCommand);
  let pluginCommand: number | undefined;
  try {
    pluginCommand = await runPluginCommand(args, {
      request: async ({ method, params, signal, workingDirectory }) => await requestAppServer({
        method,
        params,
        signal: signal ?? pluginAbortController.signal,
        transport: {
          args: [runtimePath, "app-server"],
          command: node,
          cwd: workingDirectory,
          env: runtimeEnvironment()
        }
      }),
      signal: pluginAbortController.signal
    });
  } finally {
    process.off("SIGINT", cancelPluginCommand);
    process.off("SIGTERM", cancelPluginCommand);
  }
  if (pluginCommand !== undefined) return pluginCommand;

  const login = normalizeLoginArgs(args);
  const zaiOAuth = classifyZaiOAuthInvocation(args);
  if (login.checkConfiguredAccess) {
    const access = await readConfiguredModelAccess();
    if (access) {
      console.log(
        `Model access is already configured for ${access.model}; OAuth login is not required.\n`
        + `Config: ${access.configPath}\n`
        + "Run `zcode login --oauth` to force Z.AI OAuth."
      );
      return 0;
    }
  }

  if (zaiOAuth) {
    const abortController = new AbortController();
    const cancel = () => abortController.abort(new Error("Login cancelled."));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const code = await runZaiOAuthLogin({
        abortSignal: abortController.signal,
        completeLogin: (payload, runtimeArgs) => completeOfficialZaiLogin(
          node,
          payload,
          runtimeArgs,
          abortController.signal
        ),
        invocation: zaiOAuth,
        output: zaiOAuth.json ? process.stderr : process.stdout
      });
      // A successful CLI-side login completes first-run setup; otherwise the
      // pending wizard would reappear over an already-configured account.
      if (code === 0 && await readConfiguredModelAccess()) await clearSetupPending();
      return code;
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return abortController.signal.aborted ? 130 : 1;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }

  try {
    const diagnostic = await promptPreflight(login.args);
    if (diagnostic) {
      console.error(diagnostic);
      return 1;
    }
    const runtimeArgs = withDefaultBrowserUse(login.args);
    return await runRuntime(node, runtimeArgs, firstRunSetupEnv(setupPending, runtimeArgs));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
