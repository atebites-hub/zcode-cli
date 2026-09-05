#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  type RuntimeCapabilities,
  type RuntimeCliOptionCapability
} from "../src/runtime-capabilities.ts";
import { parseReleaseVersion, syncedReleaseVersion } from "./release-version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cdnRoot = "https://cdn-zcode.z.ai/zcode/electron/releases";
const updateServiceRoot = "https://zcode.z.ai";
const updateServiceManifestPath = "/api/v1/releases/electron/manifest";
const stableReleaseChannel = "1";
const updateManifestAccept = "application/x-yaml,text/yaml,text/plain,*/*";
export const defaultAgentAutoBackgroundMs = 1_000;

export interface SyncOptions {
  platform: "darwin" | "linux" | "win32";
  arch: string;
  app?: string;
  lock?: string;
  version?: string;
}

interface Artifact {
  url: string;
  sha512: string;
}

interface UpdateManifest {
  version?: string | number;
  files?: Artifact[];
}

interface RuntimeSource {
  appVersion: string;
  glm: string;
  lock?: RuntimeLock;
  source: string;
}

export interface RuntimeLock {
  schemaVersion: 1;
  appVersion: string;
  platform: SyncOptions["platform"];
  arch: string;
  url: string;
  sha512: string;
}

export interface RuntimeManifestResolution {
  lock: RuntimeLock;
  source: "service" | "static";
  url: string;
}

export type RuntimePatchRequirement = "required" | "optional";
export type RuntimePatchStatus = "applied" | "already_present" | "skipped" | "failed";

export interface RuntimePatchReport {
  id: string;
  requirement: RuntimePatchRequirement;
  status: RuntimePatchStatus;
  message?: string;
}

export interface RuntimePatchDefinition {
  id: string;
  requirement: RuntimePatchRequirement;
  apply: (runtime: string) => string;
  verify?: (runtime: string) => boolean;
}

export function parseRuntimePatchReports(value: unknown): RuntimePatchReport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reports: RuntimePatchReport[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const report = item as Record<string, unknown>;
    if (typeof report.id !== "string" || !report.id || ids.has(report.id)) return undefined;
    if (report.requirement !== "required" && report.requirement !== "optional") return undefined;
    if (report.status !== "applied" && report.status !== "already_present"
      && report.status !== "skipped" && report.status !== "failed") return undefined;
    if (report.message !== undefined && typeof report.message !== "string") return undefined;
    ids.add(report.id);
    reports.push({
      id: report.id,
      requirement: report.requirement,
      status: report.status,
      ...(typeof report.message === "string" ? { message: report.message } : {})
    });
  }
  return reports;
}

export interface RuntimeCompatibilityFailure {
  schemaVersion: 1;
  appVersion?: string;
  generatedAt: string;
  phase: "release_validation" | "runtime_discovery" | "runtime_patch" | "runtime_sync";
  error: string;
  runtimePatches: readonly RuntimePatchReport[];
}

export class RuntimePatchError extends Error {
  readonly reports: RuntimePatchReport[];

  constructor(patch: RuntimePatchDefinition, cause: unknown, reports: RuntimePatchReport[]) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Required runtime patch ${patch.id} failed: ${detail}`, { cause });
    this.name = "RuntimePatchError";
    this.reports = reports;
  }
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

export function formatRuntimeCompatibilityFailure(report: RuntimeCompatibilityFailure): string {
  const lines = [
    "## Upstream runtime compatibility failure",
    "",
    `- App version: \`${report.appVersion ?? "unknown"}\``,
    `- Phase: \`${report.phase}\``,
    `- Detected at: \`${report.generatedAt}\``,
    "",
    "```text",
    report.error.replace(/```/gu, "'''"),
    "```"
  ];
  if (report.runtimePatches.length > 0) {
    lines.push(
      "",
      "| Patch | Requirement | Status | Detail |",
      "| --- | --- | --- | --- |",
      ...report.runtimePatches.map((patch) => [
        markdownCell(patch.id),
        patch.requirement,
        patch.status,
        markdownCell(patch.message ?? "")
      ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |"))
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeRuntimeCompatibilityFailure(
  report: RuntimeCompatibilityFailure,
  directory = join(root, ".release")
): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = join(directory, "runtime-compatibility.json");
  const markdownPath = join(directory, "runtime-compatibility.md");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, formatRuntimeCompatibilityFailure(report))
  ]);
  return { jsonPath, markdownPath };
}

type ManifestFetcher = (url: string, init?: RequestInit) => Promise<string>;

export function parseArgs(argv: string[]): SyncOptions {
  const result: SyncOptions = { platform: "linux", arch: "x64" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--app" && value) {
      result.app = value;
      index += 1;
    } else if (key === "--lock" && value) {
      result.lock = value;
      index += 1;
    } else if (key === "--platform" && (value === "darwin" || value === "linux" || value === "win32")) {
      result.platform = value;
      index += 1;
    } else if (key === "--arch" && value) {
      result.arch = value;
      index += 1;
    } else if (key === "--version" && value) {
      result.version = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
  }
  if (result.app && result.lock) throw new Error("--app and --lock cannot be used together.");
  if (result.version && !result.app) throw new Error("--version can only be used with --app.");
  return result;
}

export function parseRuntimeLock(value: unknown): RuntimeLock {
  if (!value || typeof value !== "object") throw new Error("Runtime lock must be a JSON object.");
  const candidate = value as Partial<RuntimeLock>;
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported runtime lock schema.");
  if (typeof candidate.appVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(candidate.appVersion)) {
    throw new Error("Runtime lock has an invalid App version.");
  }
  if (candidate.platform !== "darwin" && candidate.platform !== "linux" && candidate.platform !== "win32") {
    throw new Error("Runtime lock has an invalid platform.");
  }
  if (typeof candidate.arch !== "string" || !candidate.arch.trim()) {
    throw new Error("Runtime lock has an invalid architecture.");
  }
  if (typeof candidate.url !== "string") throw new Error("Runtime lock has no artifact URL.");
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch (error) {
    throw new Error("Runtime lock has an invalid artifact URL.", { cause: error });
  }
  if (url.protocol !== "https:") throw new Error("Runtime lock artifact URL must use HTTPS.");
  if (typeof candidate.sha512 !== "string"
    || Buffer.from(candidate.sha512, "base64").length !== 64
    || Buffer.from(candidate.sha512, "base64").toString("base64") !== candidate.sha512) {
    throw new Error("Runtime lock has an invalid SHA-512 digest.");
  }
  return {
    schemaVersion: 1,
    appVersion: candidate.appVersion,
    platform: candidate.platform,
    arch: candidate.arch,
    url: url.href,
    sha512: candidate.sha512
  };
}

function compareAppVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectRuntimeLock(candidate: RuntimeLock, current?: RuntimeLock): RuntimeLock {
  if (
    current
    && current.platform === candidate.platform
    && current.arch === candidate.arch
    && compareAppVersions(current.appVersion, candidate.appVersion) > 0
  ) {
    return current;
  }
  return candidate;
}

export function manifestUrl(platform: SyncOptions["platform"], arch: string): string {
  if (platform === "darwin") return `${cdnRoot}/update/mac/${arch}/latest-mac.yml`;
  if (platform === "linux") return `${cdnRoot}/update/linux/${arch}/latest-linux.yml`;
  return `${cdnRoot}/update/win/${arch}/latest.yml`;
}

export function serviceReleasePlatform(platform: SyncOptions["platform"], arch: string): string {
  const releasePlatform = platform === "darwin"
    ? "darwin"
    : platform === "win32" ? "windows" : "linux";
  const releaseArch = arch === "arm64"
    ? "aarch64"
    : arch === "x64" ? "x86_64" : arch === "ia32" ? "x86" : arch;
  return `${releasePlatform}-${releaseArch}`;
}

export function serviceManifestUrl(platform: SyncOptions["platform"], arch: string): string {
  const url = new URL(updateServiceManifestPath, updateServiceRoot);
  url.searchParams.set("platform", serviceReleasePlatform(platform, arch));
  url.searchParams.set("channel", stableReleaseChannel);
  return url.href;
}

export function resolveArtifactUrl(manifestHref: string, artifactHref: string): string {
  return new URL(artifactHref, manifestHref).href;
}

export function chooseArtifact(manifest: UpdateManifest, platform: SyncOptions["platform"]): Artifact {
  const files = manifest.files ?? [];
  const extension = platform === "linux" ? ".deb" : platform === "darwin" ? ".zip" : ".exe";
  const artifact = files.find((file) => file.url.endsWith(extension));
  if (!artifact?.url || !artifact.sha512) {
    throw new Error(`No ${extension} artifact with sha512 was found in the update manifest.`);
  }
  return artifact;
}

function parseUpdateManifest(contents: string, url: string): UpdateManifest {
  const manifest: unknown = parse(contents);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`The update manifest at ${url} is not an object.`);
  }
  return manifest as UpdateManifest;
}

async function runtimeLockFromManifest(
  options: Pick<SyncOptions, "platform" | "arch">,
  url: string,
  artifactBaseUrl: string,
  fetcher: ManifestFetcher,
  init?: RequestInit
): Promise<RuntimeLock> {
  const manifest = parseUpdateManifest(await fetcher(url, init), url);
  const artifact = chooseArtifact(manifest, options.platform);
  if (manifest.version === undefined) throw new Error("The update manifest does not contain a version.");
  return parseRuntimeLock({
    schemaVersion: 1,
    appVersion: String(manifest.version),
    platform: options.platform,
    arch: options.arch,
    url: resolveArtifactUrl(artifactBaseUrl, artifact.url),
    sha512: artifact.sha512
  });
}

export async function resolveLatestRuntimeLock(
  options: Pick<SyncOptions, "platform" | "arch">,
  fetcher: ManifestFetcher = fetchText
): Promise<RuntimeManifestResolution> {
  const serviceUrl = serviceManifestUrl(options.platform, options.arch);
  const releasePlatform = serviceReleasePlatform(options.platform, options.arch);
  try {
    const lock = await runtimeLockFromManifest(
      options,
      serviceUrl,
      new URL("/", serviceUrl).href,
      fetcher,
      {
        headers: {
          Accept: updateManifestAccept,
          "X-Platform": releasePlatform,
          "X-Release-Channel": stableReleaseChannel
        }
      }
    );
    return { lock, source: "service", url: serviceUrl };
  } catch (error) {
    const fallbackUrl = manifestUrl(options.platform, options.arch);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Stable update service manifest failed (${reason}); falling back to ${fallbackUrl}.`);
    const lock = await runtimeLockFromManifest(options, fallbackUrl, fallbackUrl, fetcher);
    return { lock, source: "static", url: fallbackUrl };
  }
}

export function supportsMultiMessageFileRewind(runtime: string): boolean {
  return /(?:Array\.isArray\([A-Za-z_$][\w$]*\.targetMessageIds\)|[A-Za-z_$][\w$]*\.targetMessageIds&&[A-Za-z_$][\w$]*\.targetMessageIds\.length>0)/u
    .test(runtime);
}

export function extractRuntimeCapabilities(runtime: string): RuntimeCapabilities {
  const parserEnd = runtime.indexOf('strict:!0}),"parseGlobalArgs"');
  const parserStart = parserEnd < 0 ? -1 : runtime.lastIndexOf("options:{", parserEnd);
  if (parserStart < 0 || parserEnd < 0) {
    throw new Error("ZCode runtime is incompatible with CLI capability extraction (global parser anchor missing).");
  }

  const optionsSource = runtime.slice(parserStart + "options:{".length, parserEnd);
  const globalOptions: Record<string, RuntimeCliOptionCapability> = {};
  const optionPattern = /(?:^|,)(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\{([^{}]*)\}/gu;
  for (const match of optionsSource.matchAll(optionPattern)) {
    const name = match[1] ?? match[2];
    const type = /(?:^|,)type:"(boolean|string)"(?:,|$)/u.exec(match[3]!)?.[1];
    if (!name || (type !== "boolean" && type !== "string")) continue;
    globalOptions[name] = {
      type,
      ...(/(?:^|,)multiple:!0(?:,|$)/u.test(match[3]!) ? { multiple: true } : {})
    };
  }
  if (!globalOptions.help || !globalOptions.version || !globalOptions.prompt) {
    throw new Error("ZCode runtime is incompatible with CLI capability extraction (global options incomplete).");
  }
  return { schemaVersion: 1, cli: { globalOptions } };
}

const legacyHeadlessOptions = [
  "settings",
  "permission-mode",
  "max-turns",
  "allowed-tools",
  "allow-main-worktree-yolo"
] as const;

function cliHelpOptionLine(option: string): RegExp {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^  --${escaped}(?:[ \\t]|$)[^\\n]*\\n`, "gmu");
}

export function hasRuntimeCliHelpContract(runtime: string): boolean {
  const supported = extractRuntimeCapabilities(runtime).cli.globalOptions;
  return legacyHeadlessOptions.every((option) => supported[option] || !cliHelpOptionLine(option).test(runtime));
}

/** Hide compatibility options that the strict global parser cannot enforce. */
export function patchRuntimeCliHelpContract(runtime: string): string {
  const supported = extractRuntimeCapabilities(runtime).cli.globalOptions;
  let patched = runtime;
  for (const option of legacyHeadlessOptions) {
    if (!supported[option]) patched = patched.replace(cliHelpOptionLine(option), "");
  }
  return patched;
}

/** Keep short Agent calls inline, but detach long-running agents from the foreground turn. */
export function patchRuntimeAgentAutoBackground(runtime: string): string {
  const marker = "autoBackgroundMs:this.config.subagents?.autoBackgroundMs??1e3,outputRootDir:";
  if (runtime.includes(marker)) return runtime;
  const anchor = "autoBackgroundMs:this.config.subagents?.autoBackgroundMs,outputRootDir:";
  if (!runtime.includes(anchor)) {
    throw new Error("ZCode runtime is incompatible with the Agent auto-background patch.");
  }
  return runtime.replace(anchor, marker);
}

/** Keep a detached Agent lifecycle failure from terminating the entire CLI process. */
export function patchRuntimeDetachedAgentLifecycle(runtime: string): string {
  const marker = 'Detached background agent lifecycle failed';
  const detachedRunnerPattern = /(onSessionStartFailed:([A-Za-z_$][\w$]*)\.reject\},[A-Za-z_$][\w$]*\.dispose)\);try\{await \2\.promise\}/gu;
  const patched = runtime.replace(
    detachedRunnerPattern,
    '$1).catch(e=>{console.error("Detached background agent lifecycle failed",e??"unknown rejection")});try{await $2.promise}'
  );
  if (patched !== runtime) return patched;
  if (!runtime.includes(marker)) {
    throw new Error("ZCode runtime is incompatible with the detached Agent lifecycle patch.");
  }
  return runtime;
}

/** Clear tool projection entries when their owning turn reaches a terminal state. */
export function patchRuntimeTerminalToolProjection(runtime: string): string {
  const completedMarker = 'status:"idle",currentTurnId:void 0,activeToolCalls:[],totalTokenCount:';
  const failedMarker = 'status:"error",currentTurnId:void 0,activeToolCalls:[],lastError:';
  let patched = runtime;
  if (!patched.includes(completedMarker)) {
    const anchor = 'status:"idle",totalTokenCount:';
    if (!patched.includes(anchor)) {
      throw new Error("ZCode runtime is incompatible with the terminal tool projection patch.");
    }
    patched = patched.replace(anchor, completedMarker);
  }
  if (!patched.includes(failedMarker)) {
    const anchor = 'status:"error",lastError:';
    if (!patched.includes(anchor)) {
      throw new Error("ZCode runtime is incompatible with the terminal tool projection patch.");
    }
    patched = patched.replace(anchor, failedMarker);
  }
  return patched;
}

/** Pause an active goal when its continuation turn fails instead of leaving it active. */
export function patchRuntimeGoalFailurePause(runtime: string): string {
  const alreadyPatchedPattern = /finishTargetTurnAccounting\(\{[^{}]*?status:"paused",traceContext:/u;
  if (alreadyPatchedPattern.test(runtime)) return runtime;

  const failureStatusPattern = /(finishTargetTurnAccounting\(\{[^{}]*?status:)[A-Za-z_$][\w$]*\.type===[A-Za-z_$][\w$]*\.TurnCancelled\?"paused":void 0(,traceContext:)/u;
  if (!failureStatusPattern.test(runtime)) {
    throw new Error("ZCode runtime is incompatible with the goal failure pause patch.");
  }
  return runtime.replace(
    failureStatusPattern,
    '$1"paused"$2'
  );
}

export function patchRuntimeTuiBridge(runtime: string): string {
  const transcriptMessageIdPattern = /\.push\(\{content:[A-Za-z_$][\w$]*,messageId:[A-Za-z_$][\w$]*\.info\.id,role:"user"\}\)/u;
  const transcriptAgentMessageIdPattern = /messageId:[A-Za-z_$][\w$]*\.info\.id,role:"agent"/u;
  const activeTranscriptPattern = /sessionStore\.messages\(\{sessionID:([A-Za-z_$][\w$]*)\.sessionId\}\),[A-Za-z_$][\w$]*=await \1\.sessionStore\.getSession\(\1\.sessionId\);return/u;
  const activeTurnSteerPattern = /(\.steerTurn\(\{commandKind:([A-Za-z_$][\w$]*)\?\.commandKind,inputId:\2\?\.inputId,queryId:\2\?\.queryId,expectedTurnId:\2\?\.expectedTurnId,)(?:delivery:"guide",)?(?:pendingInputId:\2\?\.pendingInputId,)?input:/u;
  const activeTurnGuidePattern = /\.steerTurn\(\{commandKind:([A-Za-z_$][\w$]*)\?\.commandKind,inputId:\1\?\.inputId,queryId:\1\?\.queryId,expectedTurnId:\1\?\.expectedTurnId,delivery:"guide",pendingInputId:\1\?\.pendingInputId,input:/u;
  const nativeActiveTurnSteerPattern = /([A-Za-z_$][\w$]*)\?\.delivery==="steer_active_turn".{0,700}?\.steerTurn\(\{commandKind:\1\?\.commandKind,delivery:[^,}]+,expectedTurnId:\1\?\.expectedTurnId,input:[^,}]+,inputId:\1\?\.inputId,intent:.{1,160}?,queryId:\1\?\.queryId,/u;
  const nativePromptAdmissionPattern = /\.runtime\.admitPrompt\([^{}]{0,500}\{\.\.\.([A-Za-z_$][\w$]*),delivery:[A-Za-z_$][\w$]*,traceContext:\1\?\.traceContext/u;
  const legacyStartedTurnResultPattern = /return ([A-Za-z_$][\w$]*)\.kind!=="started_turn"\?\1:([A-Za-z_$][\w$]*)\(\1\.result,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)/u;
  const supportsActiveTurnSteer = (value: string): boolean => (
    activeTurnGuidePattern.test(value)
    || (nativeActiveTurnSteerPattern.test(value) && nativePromptAdmissionPattern.test(value))
  );
  const listSkillsBridgePattern = /\.listSkills=async\(\)=>await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)/u;
  const listSkillsOptionPattern = /listSkills:[A-Za-z_$][\w$]*\.listSkills/u;
  const listModelOptionsOptionPattern = /listModelOptions:[A-Za-z_$][\w$]*\.listModelOptions/u;
  const sessionEventsBridgePattern = /\.subscribeSessionEvents=[A-Za-z_$][\w$]*=>/u;
  const sessionEventsOptionPattern = /subscribeSessionEvents:[A-Za-z_$][\w$]*\.subscribeSessionEvents/u;
  const taskMessageBridgePattern = /\.sendBackgroundTaskMessage=async [A-Za-z_$][\w$]*=>/u;
  const taskMessageOptionPattern = /sendBackgroundTaskMessage:[A-Za-z_$][\w$]*\.sendBackgroundTaskMessage/u;
  const taskMessageRestartMarker = "e?.restart===!0";
  const backgroundRestoreMarker = ".$zRestorePersistedBackgroundTasks=async $zApp=>";
  const backgroundTasksMergeMarker = "for(let $zDetail of r)";
  const backgroundRestoreSourceMarker = "$zApp.loadSessionTranscript?.()";
  const backgroundRestoreRetryMarker = "catch{$zApp.$zRestoredBackgroundTasksSession=void 0}";
  const backgroundRestoreLogMarker = ".$zRestoredBackgroundTasksLog=[]";
  const backgroundTasksRestoredFieldMarker = "restoredBackgroundTasks:Array.isArray(";
  const backgroundRestoreModelTextMarker = 'childSessionId:"sess_subagent_"+$zAgentId';
  const backgroundRestoreAsyncModelTextMarker = '$zOutput.includes("Async agent launched successfully.")';
  const backgroundRestoreReminderMarker = '.addAttachment?.("task_status"';
  const backgroundRestoreMetadataErrorMarker = "error:typeof $zMetadata.error";
  const backgroundRestoreBeforeSendMarker = ".$zSendInputWithoutBackgroundRestore=";
  const backgroundTasksReplaceMarker = "s[$zIndex]={...s[$zIndex]";
  const taskMessageRestoreMarker = ".$zRestorePersistedBackgroundTasks?.(t)";
  const interruptTurnMarker = ".interruptTurn=async e=>";
  const interruptWaitForIdleMarker = "e?.waitForIdle===!0";
  const queuedInputPromotionMarker = "r?.pendingInputReservationId??r?.queryId??";
  const projectionBridgeMarker = ".readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ";
  const modeBridgePattern = /\.setMode=async/u;
  const modeOptionPattern = /setMode:[A-Za-z_$][\w$]*\.setMode/u;
  const transientModelBridgePattern = /\.setTransientModel=async/u;
  const transientModelOptionPattern = /setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u;
  const alreadyPatched = runtime.includes(".loadSessionTranscript=async()=>await(await")
    && runtime.includes(".readGoal=async()=>await(await")
    && runtime.includes(".readTodos=async()=>await(await")
    && runtime.includes(".readRuntimeProjection=async()=>")
    && runtime.includes("backgroundTaskDetails")
    && runtime.includes(".readSessionUsage=async()=>await(await")
    && runtime.includes(".cancelBackgroundTask=async")
    && runtime.includes(".previewFileRewind=async e=>")
    && runtime.includes(".applyFileRewind=async e=>")
    && runtime.includes(interruptTurnMarker)
    && runtime.includes(interruptWaitForIdleMarker)
    && runtime.includes(".promoteQueuedInput=async(")
    && runtime.includes(queuedInputPromotionMarker)
    && !legacyStartedTurnResultPattern.test(runtime)
    && supportsActiveTurnSteer(runtime)
    && transcriptMessageIdPattern.test(runtime)
    && transcriptAgentMessageIdPattern.test(runtime)
    && supportsMultiMessageFileRewind(runtime)
    && activeTranscriptPattern.test(runtime)
    && /loadSessionTranscript:[A-Za-z_$][\w$]*\.loadSessionTranscript/u.test(runtime)
    && /readGoal:[A-Za-z_$][\w$]*\.readGoal/u.test(runtime)
    && /readTodos:[A-Za-z_$][\w$]*\.readTodos/u.test(runtime)
    && /readRuntimeProjection:[A-Za-z_$][\w$]*\.readRuntimeProjection/u.test(runtime)
    && /cancelBackgroundTask:[A-Za-z_$][\w$]*\.cancelBackgroundTask/u.test(runtime)
    && /previewFileRewind:[A-Za-z_$][\w$]*\.previewFileRewind/u.test(runtime)
    && /applyFileRewind:[A-Za-z_$][\w$]*\.applyFileRewind/u.test(runtime)
    && /interruptTurn:[A-Za-z_$][\w$]*\.interruptTurn/u.test(runtime)
    && /promoteQueuedInput:[A-Za-z_$][\w$]*\.promoteQueuedInput/u.test(runtime)
    && /readSessionUsage:[A-Za-z_$][\w$]*\.readSessionUsage/u.test(runtime)
    && listSkillsBridgePattern.test(runtime)
    && listSkillsOptionPattern.test(runtime)
    && listModelOptionsOptionPattern.test(runtime)
    && modeBridgePattern.test(runtime)
    && modeOptionPattern.test(runtime)
    && transientModelBridgePattern.test(runtime)
    && transientModelOptionPattern.test(runtime)
    && sessionEventsBridgePattern.test(runtime)
    && sessionEventsOptionPattern.test(runtime)
    && taskMessageBridgePattern.test(runtime)
    && taskMessageOptionPattern.test(runtime)
    && runtime.includes(taskMessageRestartMarker)
    && runtime.includes(projectionBridgeMarker)
    && runtime.includes(backgroundRestoreMarker)
    && runtime.includes(backgroundTasksMergeMarker)
    && runtime.includes(backgroundRestoreSourceMarker)
    && runtime.includes(backgroundRestoreRetryMarker)
    && runtime.includes(backgroundRestoreLogMarker)
    && runtime.includes(backgroundTasksRestoredFieldMarker)
    && runtime.includes(backgroundRestoreModelTextMarker)
    && runtime.includes(backgroundRestoreAsyncModelTextMarker)
    && runtime.includes(backgroundRestoreReminderMarker)
    && runtime.includes(backgroundRestoreMetadataErrorMarker)
    && runtime.includes(backgroundRestoreBeforeSendMarker)
    && runtime.includes(backgroundTasksReplaceMarker)
    && runtime.includes(taskMessageRestoreMarker)
    && runtime.includes(".loadSessionContextMessages=async()=>await(await")
    && /loadSessionContextMessages:[A-Za-z_$][\w$]*\.loadSessionContextMessages/u.test(runtime);
  if (alreadyPatched) return runtime;

  let patched = runtime;
  patched = patched.replace(
    legacyStartedTurnResultPattern,
    'return $1.kind!=="started_turn"?$1:$2(await($1.result??$1.completion),$3,$4($5))'
  );
  if (!supportsActiveTurnSteer(patched)) {
    if (!activeTurnSteerPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (active-turn steer delivery anchor missing).");
    }
    patched = patched.replace(
      activeTurnSteerPattern,
      '$1delivery:"guide",pendingInputId:$2?.pendingInputId,input:'
    );
  }
  if (!activeTranscriptPattern.test(patched)) {
    const activeFilter = /function ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{return [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\{(?:branchCutAfterMessageId:[A-Za-z_$][\w$]*\.revert\?\.branchCutAfterMessageID,)?rewindCreatedMessageId:[A-Za-z_$][\w$]*\.revert\?\.createdMessageID,rewindKeptMessageIds:[A-Za-z_$][\w$]*\.revert\?\.keptMessageIDs,rewindTargetMessageId:[A-Za-z_$][\w$]*\.revert\?\.targetMessageID\}\)\}/u.exec(patched)?.[1];
    const transcriptLoaderPattern = /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{if\(!\2\.sessionStore\)return\[\];let ([A-Za-z_$][\w$]*)=await \2\.sessionStore\.messages\(\{sessionID:\2\.sessionId\}\);return ([A-Za-z_$][\w$]*)\(\3\)\}/u;
    if (!activeFilter || !transcriptLoaderPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (active transcript anchor missing).");
    }
    patched = patched.replace(
      transcriptLoaderPattern,
      `async function $1($2){if(!$2.sessionStore)return[];let $3=await $2.sessionStore.messages({sessionID:$2.sessionId}),r=await $2.sessionStore.getSession($2.sessionId);return $4(r?${activeFilter}($3,r):$3)}`
    );
  }
  if (!transcriptMessageIdPattern.test(patched)) {
    const userProjectionPattern = /(if\(([A-Za-z_$][\w$]*)\.info\.role==="user"\)\{.{0,400}?)([A-Za-z_$][\w$]*)\.push\(\{content:([A-Za-z_$][\w$]*),role:"user"\}\)(;continue\})/u;
    if (!userProjectionPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (transcript message-id anchor missing).");
    }
    patched = patched.replace(
      userProjectionPattern,
      "$1$3.push({content:$4,messageId:$2.info.id,role:\"user\"})$5"
    );
  }
  if (!transcriptAgentMessageIdPattern.test(patched)) {
    const agentProjectionPattern = /([A-Za-z_$][\w$]*)\.push\(\{content:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)\.length>0\?\{parts:\3\}:\{\},role:"agent"\}\)/u;
    const agentProjection = agentProjectionPattern.exec(patched);
    const functionStart = agentProjection ? patched.lastIndexOf("function ", agentProjection.index) : -1;
    const messageRecord = functionStart >= 0 && agentProjection
      ? /for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)\{/u.exec(
          patched.slice(functionStart, agentProjection.index)
        )?.[1]
      : undefined;
    if (!agentProjection || !messageRecord) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (assistant message-id anchor missing).");
    }
    patched = patched.replace(
      agentProjectionPattern,
      `$1.push({content:$2,...$3.length>0?{parts:$3}:{},messageId:${messageRecord}.info.id,role:"agent"})`
    );
  }
  if (!supportsMultiMessageFileRewind(patched)) {
    const fileRewindTargetPattern = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(\3\.targetMessageId\)return ([A-Za-z_$][\w$]*)\(\2,\[\3\.targetMessageId\]\);/u;
    if (!fileRewindTargetPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (multi-message file rewind anchor missing).");
    }
    patched = patched.replace(
      fileRewindTargetPattern,
      "function $1($2,$3){if(Array.isArray($3.targetMessageIds)&&$3.targetMessageIds.length>0)return $4($2,$3.targetMessageIds);if($3.targetMessageId)return $4($2,[$3.targetMessageId]);"
    );
  }
  if (!patched.includes('"loadSessionContextMessages"') || !patched.includes('"readSessionUsage"')) {
    const appPattern = /loadSessionTranscript:([A-Za-z_$][\w$]*)\(async\(\)=>await ([A-Za-z_$][\w$]*)\(\{sessionId:([A-Za-z_$][\w$]*)\.sessionId,sessionStore:\3\.sessionStore\}\),"loadSessionTranscript"\)/u;
    const app = appPattern.exec(patched);
    if (!app) throw new Error("ZCode runtime is incompatible with the TUI bridge (session context anchor missing).");
    const [appAssignment, helper, , context] = app;
    const appMethods = [
      !patched.includes('"loadSessionContextMessages"')
        ? `loadSessionContextMessages:${helper}(async()=>await ${context}.sessionStore.messages({sessionID:${context}.sessionId}),"loadSessionContextMessages")`
        : undefined,
      !patched.includes('"readSessionUsage"')
        ? `readSessionUsage:${helper}(async()=>await ${context}.sessionStore.queryTaskUsage?.({sessionID:${context}.sessionId})??null,"readSessionUsage")`
        : undefined
    ].filter(Boolean);
    patched = patched.replace(appAssignment, `${appAssignment},${appMethods.join(",")}`);
  }

  const assignmentPattern = /([A-Za-z_$][\w$]*)\.recallPreviousInput=async ([A-Za-z_$][\w$]*)=>await\(await ([A-Za-z_$][\w$]*)\(\)\)\.recallPreviousInputHistory\?\.\(\2\)\?\?null/u;
  const assignment = assignmentPattern.exec(patched);
  if (!assignment) throw new Error("ZCode runtime is incompatible with the TUI bridge (adapter assignment anchor missing).");

  const [recallAssignment, bridge, , getApp] = assignment;
  const assignments: string[] = [];
  // Persisted background-agent restore: after a CLI restart + session resume the
  // in-memory runtimeTaskRegistry is empty, so /tasks lists nothing and
  // sendBackgroundTaskMessage cannot find the task. The runtime already ships a
  // resume-from-child-session path (sendMessage on a stopped local_agent task),
  // so re-registering spawn records from the already active-branch-filtered
  // transcript is enough to make /tasks and /tasks resume work again.
  const backgroundRestoreAssignment = `${bridge}.$zRestorePersistedBackgroundTasks=async $zApp=>{let $zRuntime=$zApp?.runtime,$zRegistry=$zRuntime?.runtimeTaskRegistry;if(!$zRegistry?.register||typeof $zApp?.sessionId!="string"||$zApp.sessionId===$zApp.$zRestoredBackgroundTasksSession)return;$zApp.$zRestoredBackgroundTasksSession=$zApp.sessionId,$zApp.$zRestoredBackgroundTasksLog=[];try{let $zMessages=await $zApp.loadSessionTranscript?.()??[],$zRestored=[];for(let $zMessage of $zMessages){let $zParts=Array.isArray($zMessage?.parts)?$zMessage.parts:[];for(let $zPart of $zParts){if($zPart?.type!=="tool")continue;let $zToolName=typeof $zPart.toolName==="string"?$zPart.toolName:typeof $zPart.tool==="string"?$zPart.tool:"";$zToolName=$zToolName.trim().toLowerCase();if($zToolName!=="agent"&&$zToolName!=="subagent"&&$zToolName!=="task")continue;let $zInput=$zPart.input??$zPart.state?.input,$zOutput=typeof $zPart.output==="string"?$zPart.output:$zPart.state?.output;if(typeof $zOutput!=="string"||$zOutput.trim().length===0)continue;let $zSpawn;try{$zSpawn=JSON.parse($zOutput)}catch{}if(!$zSpawn||typeof $zSpawn!=="object"||Array.isArray($zSpawn)){let $zAgentId=/(?:^|\\n)agentId:\\s*([^\\s(]+)/u.exec($zOutput)?.[1],$zOutputFile=/(?:^|\\n)output_file:\\s*([^\\r\\n]+)/u.exec($zOutput)?.[1]?.trim();if(typeof $zAgentId!=="string"||$zAgentId.length===0)continue;$zSpawn={status:"async_launched",agentId:$zAgentId,agentType:typeof $zInput?.subagent_type==="string"&&$zInput.subagent_type.length>0?$zInput.subagent_type:typeof $zInput?.agentType==="string"&&$zInput.agentType.length>0?$zInput.agentType:void 0,childSessionId:"sess_subagent_"+$zAgentId,description:typeof $zInput?.description==="string"&&$zInput.description.length>0?$zInput.description:void 0,prompt:typeof $zInput?.prompt==="string"&&$zInput.prompt.length>0?$zInput.prompt:void 0,...$zOutputFile?{outputFile:$zOutputFile}:{}}}if(($zSpawn.status!=="async_launched"&&$zSpawn.status!=="backgrounded")||typeof $zSpawn.agentId!=="string"||$zSpawn.agentId.length===0)continue;let $zMetadata;if(typeof $zSpawn.outputFile==="string"&&$zSpawn.outputFile.length>0)try{let $zBuiltin=process.getBuiltinModule;if(typeof $zBuiltin==="function"){let $zFs=$zBuiltin.call(process,"node:fs"),$zPath=$zBuiltin.call(process,"node:path");$zMetadata=JSON.parse($zFs.readFileSync($zPath.join($zPath.dirname($zSpawn.outputFile),"metadata.json"),"utf8"))}}catch{}if($zMetadata&&typeof $zMetadata==="object"&&!Array.isArray($zMetadata)&&(typeof $zMetadata.agentId!=="string"||$zMetadata.agentId===$zSpawn.agentId)&&(typeof $zMetadata.parentSessionId!=="string"||$zMetadata.parentSessionId===$zApp.sessionId))$zSpawn={...$zSpawn,agentType:typeof $zMetadata.profileId==="string"&&$zMetadata.profileId.length>0?$zMetadata.profileId:$zSpawn.agentType,childSessionId:typeof $zMetadata.childSessionId==="string"&&$zMetadata.childSessionId.length>0?$zMetadata.childSessionId:$zSpawn.childSessionId,description:typeof $zMetadata.description==="string"&&$zMetadata.description.length>0?$zMetadata.description:$zSpawn.description,outputFile:typeof $zMetadata.outputFile==="string"&&$zMetadata.outputFile.length>0?$zMetadata.outputFile:$zSpawn.outputFile,prompt:typeof $zMetadata.prompt==="string"&&$zMetadata.prompt.length>0?$zMetadata.prompt:$zSpawn.prompt,error:typeof $zMetadata.error==="string"&&$zMetadata.error.length>0?$zMetadata.error:$zSpawn.error};if(typeof $zSpawn.childSessionId!=="string"||$zSpawn.childSessionId.length===0)$zSpawn.childSessionId="sess_subagent_"+$zSpawn.agentId;if($zRegistry.get?.($zSpawn.agentId))continue;let $zStatus="stopped";if($zMetadata?.status==="completed")$zStatus="completed";else if($zMetadata?.status==="failed")$zStatus="failed";let $zTask={taskId:$zSpawn.agentId,agentId:$zSpawn.agentId,agentType:typeof $zSpawn.agentType==="string"&&$zSpawn.agentType.length>0?$zSpawn.agentType:"general-purpose",childSessionId:$zSpawn.childSessionId,description:typeof $zSpawn.description==="string"&&$zSpawn.description.length>0?$zSpawn.description:void 0,error:typeof $zSpawn.error==="string"&&$zSpawn.error.length>0?$zSpawn.error:void 0,isBackgrounded:!0,outputFile:typeof $zSpawn.outputFile==="string"&&$zSpawn.outputFile.length>0?$zSpawn.outputFile:void 0,parentToolCallId:typeof $zPart.toolCallId==="string"&&$zPart.toolCallId.length>0?$zPart.toolCallId:typeof $zPart.callID==="string"&&$zPart.callID.length>0?$zPart.callID:void 0,parentSessionId:$zApp.sessionId,prompt:typeof $zSpawn.prompt==="string"&&$zSpawn.prompt.length>0?$zSpawn.prompt:void 0,startedAt:$zPart.state?.time?.start,status:$zStatus,taskType:"local_agent",type:"local_agent"};$zRegistry.register($zTask),$zRestored.push($zTask)}}if($zRestored.length>0){let $zTaskIds=$zRestored.slice(-32).map($zTask=>"- "+$zTask.taskId+" ("+$zTask.status+")").join("\\n").slice(0,4e3);$zRuntime?.messageHistory?.addAttachment?.("task_status","Background agent tasks from this resumed session have been restored and are available again.\\nEarlier TaskOutput errors saying \\"No task found\\" occurred before restoration and are stale.\\nUse TaskOutput to collect results or SendMessage to continue a task. Do not assume these tasks were lost.\\nRestored task IDs:\\n"+$zTaskIds),$zApp.$zRestoredBackgroundTasksLog=[...($zApp.$zRestoredBackgroundTasksLog??[]),...$zRestored].slice(-64)}}catch{$zApp.$zRestoredBackgroundTasksSession=void 0}}`;
  const guardedBackgroundRestoreAssignment = backgroundRestoreAssignment.replace(
    'if(!$zSpawn||typeof $zSpawn!=="object"||Array.isArray($zSpawn)){let $zAgentId=',
    'if(!$zSpawn||typeof $zSpawn!=="object"||Array.isArray($zSpawn)){if(!$zOutput.includes("Async agent launched successfully."))continue;let $zAgentId='
  );
  const projectionAssignment = `${bridge}.readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ${getApp}();await ${bridge}.$zRestorePersistedBackgroundTasks?.($zRuntimeProjectionBridge);let t=await $zRuntimeProjectionBridge.runtime?.getProjection?.();if(!t)return null;let r=Object.values($zRuntimeProjectionBridge.runtime?.runtimeTaskRegistry?.all?.()??{}).filter(o=>o.isBackgrounded===!0).map(o=>({taskId:o.taskId,taskKind:o.taskType??o.type,agentId:o.agentId,agentType:o.agentType,childSessionId:o.childSessionId,parentSessionId:o.parentSessionId,parentToolCallId:o.parentToolCallId,turnId:o.turnId,prompt:o.prompt,error:o.status==="running"?null:o.error instanceof Error?o.error.message:typeof o.error==="string"?o.error:void 0,outputPath:o.outputFile,status:o.status,description:o.description,startedAt:o.startedAt,completedAt:o.status==="running"?null:o.completedAt,cancelRequestedAt:o.status==="running"?null:o.cancelRequestedAt,blocked:o.status==="running"?null:o.blocked,blockedReason:o.status==="running"?null:o.blockedReason,cancellable:(o.taskType??o.type)==="local_agent"?o.status==="running":o.cancellable}));let s=Array.isArray(t.backgroundTasks)?t.backgroundTasks.slice():[];for(let $zDetail of r){let $zIndex=s.findIndex($zExisting=>$zExisting.taskId===$zDetail.taskId);if($zIndex<0)s.push($zDetail);else s[$zIndex]={...s[$zIndex],...Object.fromEntries(Object.entries($zDetail).filter(([,v])=>v!==void 0))}}return{...t,backgroundTasks:s,backgroundTaskDetails:r,restoredBackgroundTasks:Array.isArray($zRuntimeProjectionBridge.$zRestoredBackgroundTasksLog)?$zRuntimeProjectionBridge.$zRestoredBackgroundTasksLog:[]}}`;
  const taskMessageAssignment = `${bridge}.sendBackgroundTaskMessage=async e=>{let t=await ${getApp}();await ${bridge}.$zRestorePersistedBackgroundTasks?.(t);let r=t.runtime,o=r?.runtimeTaskRegistry?.get?.(e?.taskId);if(!o&&typeof t.sessionId==="string"){t.$zRestoredBackgroundTasksSession=void 0;await ${bridge}.$zRestorePersistedBackgroundTasks?.(t);o=r?.runtimeTaskRegistry?.get?.(e?.taskId)}if(!r?.subagentPort?.sendMessage)throw new Error("Background agent messaging is unavailable in this runtime.");if(!o||(o.type??o.taskType)!=="local_agent")throw new Error("The selected task is not a local agent.");if(typeof e?.message!=="string"||!e.message.trim())throw new Error("Enter a message for the background agent.");let n=e.message.trim().slice(0,2e4),i=(typeof e.summary==="string"?e.summary:n).replace(/\\s+/g," ").trim().slice(0,200);if(e?.restart===!0&&o.status==="running"){if(!r.subagentPort.stopTask)throw new Error("Background agent restart is unavailable in this runtime.");await r.subagentPort.stopTask(e.taskId),o=r.runtimeTaskRegistry?.get?.(e.taskId);if(!o)throw new Error("The background agent stopped but could not be restored.")}return await r.subagentPort.sendMessage({sessionId:o.parentSessionId??r.getSessionId?.(),turnId:o.turnId??"tui-task-message",parentToolCallId:o.parentToolCallId??"tui-task-message",to:o.agentId??e.taskId,summary:i,message:n,workingDirectory:o.workingDirectory??r.workingDirectory,workspaceRoot:o.workspaceRoot??r.workingDirectory,trace:o.traceContext??r.rootTraceContext})}`;
  if (!listSkillsBridgePattern.test(patched)) {
    const listSkillsFactory = /listSkills:[A-Za-z_$][\w$]*\(\(\)=>([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),"listSkills"\)/u
      .exec(patched);
    if (!listSkillsFactory) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (skill-list adapter anchor missing).");
    }
    assignments.push(`${bridge}.listSkills=async()=>await ${listSkillsFactory[1]}(${listSkillsFactory[2]})`);
  }
  const interruptAssignment = `${bridge}.interruptTurn=async e=>{let t=await ${getApp}(),r=e?.reservationId??"tui-steer-interrupt",o=(Array.isArray(e?.pendingInputIds)?e.pendingInputIds:[]).filter(Boolean),n=[],i=async()=>{for(let a of n)await t.releaseQueueItemReservation?.(a,r);n=[]};try{if(t.reserveQueueItem&&t.releaseQueueItemReservation)for(let a of o)if(await t.reserveQueueItem(a,r))n.push(a);else{await i();break}let a=t.runtime?.stopActiveForegroundExecution?.({preserveQueueAutoDrainOnCancel:o.length>0&&n.length===o.length,reason:e?.reason??"TUI steer interrupt"})??{kind:"unsupported"};if(a.kind==="stopped"&&e?.waitForIdle===!0&&t.runtime?.getActiveForegroundExecutionId){let u=Date.now()+5e3;for(;t.runtime.getActiveForegroundExecutionId()!==void 0;){if(Date.now()>=u)throw new Error("Timed out waiting for background result processing to stop.");await new Promise(l=>setTimeout(l,25))}}return a.kind!=="stopped"&&await i(),a}catch(a){await i();throw a}}`;
  const promotionAssignment = `${bridge}.promoteQueuedInput=async(e,t,r)=>{let o=await ${getApp}(),n=r?.pendingInputReservationId??r?.queryId??r?.inputId??"tui-promotion",i=(Array.isArray(t)?t:[t]).filter(Boolean);if(i.length===0||!o.reserveQueueItem||!o.markQueueItemPromoting||!o.releaseQueueItemReservation||!o.removeQueueItem)return ${bridge}.sendInput(e,{...r,delivery:"start_turn"});let a=[],u=!1;try{for(let l of i){if(await o.markQueueItemPromoting(l,n)){a.push(l);continue}if(!await o.reserveQueueItem(l,n))throw new Error("TUI queued input is already reserved: "+l);a.push(l);if(!await o.markQueueItemPromoting(l,n))throw new Error("TUI queued input promotion failed: "+l)}let c=await ${bridge}.sendInput(e,{...r,delivery:"start_turn"});if(c?.kind==="rejected")return c;u=!0;for(let l of a)if(!await o.removeQueueItem(l,{reason:"promoted",reservationId:n}))throw new Error("TUI queued input promotion commit failed: "+l);return c}finally{if(!u)for(let l of a)await o.releaseQueueItemReservation(l,n)}}`;
  if (!patched.includes(".loadSessionTranscript=async()=>await(await")) {
    assignments.push(`${bridge}.loadSessionTranscript=async()=>await(await ${getApp}()).loadSessionTranscript?.()??[]`);
  }
  if (!patched.includes(".loadSessionContextMessages=async()=>await(await")) {
    assignments.push(`${bridge}.loadSessionContextMessages=async()=>await(await ${getApp}()).loadSessionContextMessages?.()??[]`);
  }
  if (!patched.includes(".readGoal=async()=>await(await")) {
    assignments.push(`${bridge}.readGoal=async()=>await(await ${getApp}()).readTarget?.()??null`);
  }
  if (!patched.includes(".readTodos=async()=>await(await")) {
    assignments.push(`${bridge}.readTodos=async()=>await(await ${getApp}()).readTodos?.()??[]`);
  }
  if (!patched.includes(projectionBridgeMarker) || !patched.includes(backgroundRestoreMarker)
    || !patched.includes(backgroundTasksMergeMarker) || !patched.includes(backgroundTasksReplaceMarker)
    || !patched.includes(backgroundTasksRestoredFieldMarker)) {
    const existingProjectionStart = `${bridge}.readRuntimeProjection=async()=>`;
    const existingProjectionIndex = patched.indexOf(existingProjectionStart);
    if (existingProjectionIndex >= 0) {
      const existingProjectionEnd = patched.indexOf(`,${bridge}.`, existingProjectionIndex + existingProjectionStart.length);
      if (existingProjectionEnd < 0) {
        throw new Error("ZCode runtime is incompatible with the TUI bridge (projection boundary missing).");
      }
      patched = `${patched.slice(0, existingProjectionIndex)}${projectionAssignment}${patched.slice(existingProjectionEnd)}`;
    } else {
      assignments.push(projectionAssignment);
    }
  }
  if (!patched.includes(backgroundRestoreMarker) || !patched.includes(backgroundRestoreSourceMarker)
    || !patched.includes(backgroundRestoreRetryMarker) || !patched.includes(backgroundRestoreLogMarker)
    || !patched.includes(backgroundRestoreModelTextMarker)
    || !patched.includes(backgroundRestoreAsyncModelTextMarker)
    || !patched.includes(backgroundRestoreReminderMarker)
    || !patched.includes(backgroundRestoreMetadataErrorMarker)) {
    const existingRestoreStart = patched.indexOf(`${bridge}.$zRestorePersistedBackgroundTasks=async $zApp=>`);
    if (existingRestoreStart >= 0) {
      const existingRestoreEnd = patched.indexOf(`,${bridge}.`, existingRestoreStart);
      if (existingRestoreEnd < 0) {
        throw new Error("ZCode runtime is incompatible with the TUI bridge (background restore boundary missing).");
      }
      patched = `${patched.slice(0, existingRestoreStart)}${guardedBackgroundRestoreAssignment}${patched.slice(existingRestoreEnd)}`;
    } else {
      assignments.push(guardedBackgroundRestoreAssignment);
    }
  }
  if (!patched.includes(".readSessionUsage=async()=>await(await")) {
    assignments.push(`${bridge}.readSessionUsage=async()=>await(await ${getApp}()).readSessionUsage?.()??null`);
  }
  if (!patched.includes(".cancelBackgroundTask=async")) {
    assignments.push(`${bridge}.cancelBackgroundTask=async e=>await(await ${getApp}()).cancelBackgroundTask?.(e)??null`);
  }
  if (!patched.includes(".previewFileRewind=async e=>")) {
    assignments.push(`${bridge}.previewFileRewind=async e=>{let t=await ${getApp}();return await t.runtime?.previewWorkspaceFileRewind?.({targetMessageIds:e})??null}`);
  }
  if (!patched.includes(".applyFileRewind=async e=>")) {
    assignments.push(`${bridge}.applyFileRewind=async e=>{let t=await ${getApp}();return await t.runtime?.applyWorkspaceFileRewind?.({targetMessageIds:e})??null}`);
  }
  if (!modeBridgePattern.test(patched)) {
    assignments.push(`${bridge}.setMode=async e=>{let t=await ${getApp}();if(t.setMode)return await t.setMode(e);t.runtime?.updateConfig?.({mode:e});return{mode:t.getMode?.()??e}}`);
  }
  // Session-level (transient) model switch: the runtime's setModel persists
  // model.main to config.json by default; {transient:true} keeps it in-memory
  // so the /model quick picker does not rewrite saved defaults.
  if (!patched.includes(".setTransientModel=async")) {
    assignments.push(`${bridge}.setTransientModel=async e=>await(await ${getApp}()).setModel?.(e,{transient:!0})`);
  }
  if (!sessionEventsBridgePattern.test(patched)) {
    assignments.push(`${bridge}.subscribeSessionEvents=e=>{let t=!1,r;${getApp}().then(o=>{t||(r=o.runtime?.subscribeEvents?.({onSessionEvent:e}))});return()=>{t=!0,r?.()}}`);
  }
  if (!taskMessageBridgePattern.test(patched)) {
    assignments.push(taskMessageAssignment);
  } else if (!patched.includes(taskMessageRestartMarker) || !patched.includes(taskMessageRestoreMarker)) {
    const existingTaskMessageStart = patched.indexOf(`${bridge}.sendBackgroundTaskMessage=async e=>`);
    const existingTaskMessageEnd = existingTaskMessageStart < 0
      ? -1
      : patched.indexOf(`,${bridge}.`, existingTaskMessageStart);
    if (existingTaskMessageStart < 0 || existingTaskMessageEnd < 0) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (task-message boundary missing).");
    }
    patched = `${patched.slice(0, existingTaskMessageStart)}${taskMessageAssignment}${patched.slice(existingTaskMessageEnd)}`;
  }
  if (!patched.includes(interruptTurnMarker)) {
    assignments.push(interruptAssignment);
  } else if (!patched.includes(interruptWaitForIdleMarker)) {
    const existingInterruptStart = patched.indexOf(`${bridge}.interruptTurn=async e=>`);
    const existingInterruptEnd = existingInterruptStart < 0
      ? -1
      : patched.indexOf(`,${bridge}.`, existingInterruptStart);
    if (existingInterruptStart < 0 || existingInterruptEnd < 0) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (interrupt boundary missing).");
    }
    patched = `${patched.slice(0, existingInterruptStart)}${interruptAssignment}${patched.slice(existingInterruptEnd)}`;
  }
  if (!patched.includes(queuedInputPromotionMarker)) {
    const existingPromotionStart = patched.indexOf(`${bridge}.promoteQueuedInput=async(`);
    if (existingPromotionStart >= 0) {
      const existingPromotionEnd = patched.indexOf(`,${bridge}.recallPreviousInput=`, existingPromotionStart);
      if (existingPromotionEnd < 0) {
        throw new Error("ZCode runtime is incompatible with the TUI bridge (queued-input promotion boundary missing).");
      }
      patched = `${patched.slice(0, existingPromotionStart)}${promotionAssignment}${patched.slice(existingPromotionEnd)}`;
    } else {
      assignments.push(promotionAssignment);
    }
  }
  if (!patched.includes(backgroundRestoreBeforeSendMarker)) {
    assignments.push(
      `${bridge}.$zSendInputWithoutBackgroundRestore=${bridge}.sendInput,${bridge}.sendInput=async(...$zArgs)=>{let $zApp=await ${getApp}();await ${bridge}.$zRestorePersistedBackgroundTasks?.($zApp);return await ${bridge}.$zSendInputWithoutBackgroundRestore.apply(${bridge},$zArgs)}`
    );
  }
  if (assignments.length > 0) {
    patched = patched.replace(recallAssignment, `${assignments.join(",")},${recallAssignment}`);
  }

  const optionsPattern = /recallPreviousInput:([A-Za-z_$][\w$]*)\.recallPreviousInput,sendInput:\1\.sendInput/u;
  const options = optionsPattern.exec(patched);
  if (!options) throw new Error("ZCode runtime is incompatible with the TUI bridge (runTui options anchor missing).");
  const [optionsAssignment, submitBridge] = options;
  const optionFields: string[] = [];
  if (!/loadSessionTranscript:[A-Za-z_$][\w$]*\.loadSessionTranscript/u.test(patched)) {
    optionFields.push(`loadSessionTranscript:${submitBridge}.loadSessionTranscript`);
  }
  if (!/loadSessionContextMessages:[A-Za-z_$][\w$]*\.loadSessionContextMessages/u.test(patched)) {
    optionFields.push(`loadSessionContextMessages:${submitBridge}.loadSessionContextMessages`);
  }
  if (!/readGoal:[A-Za-z_$][\w$]*\.readGoal/u.test(patched)) {
    optionFields.push(`readGoal:${submitBridge}.readGoal`);
  }
  if (!/readTodos:[A-Za-z_$][\w$]*\.readTodos/u.test(patched)) {
    optionFields.push(`readTodos:${submitBridge}.readTodos`);
  }
  if (!/readRuntimeProjection:[A-Za-z_$][\w$]*\.readRuntimeProjection/u.test(patched)) {
    optionFields.push(`readRuntimeProjection:${submitBridge}.readRuntimeProjection`);
  }
  if (!/readSessionUsage:[A-Za-z_$][\w$]*\.readSessionUsage/u.test(patched)) {
    optionFields.push(`readSessionUsage:${submitBridge}.readSessionUsage`);
  }
  if (!/cancelBackgroundTask:[A-Za-z_$][\w$]*\.cancelBackgroundTask/u.test(patched)) {
    optionFields.push(`cancelBackgroundTask:${submitBridge}.cancelBackgroundTask`);
  }
  if (!/previewFileRewind:[A-Za-z_$][\w$]*\.previewFileRewind/u.test(patched)) {
    optionFields.push(`previewFileRewind:${submitBridge}.previewFileRewind`);
  }
  if (!/applyFileRewind:[A-Za-z_$][\w$]*\.applyFileRewind/u.test(patched)) {
    optionFields.push(`applyFileRewind:${submitBridge}.applyFileRewind`);
  }
  if (!/interruptTurn:[A-Za-z_$][\w$]*\.interruptTurn/u.test(patched)) {
    optionFields.push(`interruptTurn:${submitBridge}.interruptTurn`);
  }
  if (!/promoteQueuedInput:[A-Za-z_$][\w$]*\.promoteQueuedInput/u.test(patched)) {
    optionFields.push(`promoteQueuedInput:${submitBridge}.promoteQueuedInput`);
  }
  if (!listSkillsOptionPattern.test(patched)) {
    optionFields.push(`listSkills:${submitBridge}.listSkills`);
  }
  if (!/listModelOptions:[A-Za-z_$][\w$]*\.listModelOptions/u.test(patched)) {
    optionFields.push(`listModelOptions:${submitBridge}.listModelOptions`);
  }
  if (!modeOptionPattern.test(patched)) {
    optionFields.push(`setMode:${submitBridge}.setMode`);
  }
  if (!/setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u.test(patched)) {
    optionFields.push(`setTransientModel:${submitBridge}.setTransientModel`);
  }
  if (!sessionEventsOptionPattern.test(patched)) {
    optionFields.push(`subscribeSessionEvents:${submitBridge}.subscribeSessionEvents`);
  }
  if (!taskMessageOptionPattern.test(patched)) {
    optionFields.push(`sendBackgroundTaskMessage:${submitBridge}.sendBackgroundTaskMessage`);
  }
  if (optionFields.length > 0) {
    patched = patched.replace(optionsAssignment, `${optionFields.join(",")},${optionsAssignment}`);
  }
  return patched;
}

/**
 * Inject a token-usage footer into the headless `runPrompt` exit path so ODW (and any
 * ZCODE_ODW_PROTOCOL=1 caller) can recover token telemetry from the otherwise-opaque
 * single-envelope run. The launcher captures stdout as the agent text and historically
 * hardcodes all telemetry to null — the runtime has the data (sessionId + per-turn usage
 * + a projection token total) but never emits it in prompt mode. This patch makes the
 * non-JSON prompt exit ALSO write a structured `{"type":"zcode_usage",...}` line to
 * stderr when ZCODE_ODW_PROTOCOL=1; the launcher strips + parses it and fills the
 * envelope. Gated on the env var so normal `zcode --prompt` output is unchanged.
 *
 * Anchor: the `runPrompt` non-JSON branch — `:(<streams>.stdout.write(`<result>\n`),0)}catch(<e>)`
 * — where <streams>, <result>, <catchvar> are minified names captured from the pattern itself
 * (same variable-name-discovery technique as patchRuntimeTuiBridge). The result object carries
 * `.usage` (per-turn) and `.projection.totalTokenCount`; the app object carries `.sessionId`.
 *
 * 在 headless `runPrompt` 的退出路径上注入一条 token-usage 尾行，使 ODW（以及任何
 * ZCODE_ODW_PROTOCOL=1 的调用方）能从原本不透明的单信封运行中取回 token 遥测。launcher 把
 * stdout 当作 agent 文本捕获，历史上把所有遥测硬编码为 null —— 运行时有数据（sessionId + 单轮
 * usage + projection 的 token 总数），但 prompt 模式从不输出。本补丁让非 JSON 的 prompt 退出在
 * ZCODE_ODW_PROTOCOL=1 时【额外】向 stderr 写一行结构化的 `{"type":"zcode_usage",...}`；launcher
 * 将其剥离并解析、填入信封。以环境变量收口，正常的 `zcode --prompt` 输出不变。
 *
 * 锚点：`runPrompt` 的非 JSON 分支 —— `:(<streams>.stdout.write(`<result>\n`),0)}catch(<e>)`
 * —— 其中 <streams>、<result>、<catchvar> 是从模式本身捕获的压缩名（与 patchRuntimeTuiBridge
 * 同样的变量名发现技术）。result 对象带 `.usage`（单轮）与 `.projection.totalTokenCount`；
 * app 对象带 `.sessionId`。
 */
export function patchRuntimeUsageFooter(runtime: string): string {
  // Idempotency: the injected footer writes `JSON.stringify({type:"zcode_usage",...})` to stderr.
  // In the bundled source that appears with escaped quotes ({type:\"zcode_usage\"}), so match the
  // stable unescaped substring `zcode_usage` (it does not occur in the upstream runtime).
  // 幂等性：注入的 footer 向 stderr 写 `JSON.stringify({type:"zcode_usage",...})`。在 bundle 源码
  // 里它带转义引号（{type:\"zcode_usage\"}），故匹配稳定且未转义的子串 `zcode_usage`
  //（上游 runtime 中不出现该串）。
  if (runtime.includes("zcode_usage")) return runtime;

  // Anchor on the projection totalTokenCount write (JSON branch) through the non-JSON stdout
  // write, capturing the streams object, the result object, and the app object. The
  // `totalTokenCount:<app>.projection.totalTokenCount` pin identifies the JSON branch of the
  // runPrompt result; the following `:(<streams>.stdout.write(`<result>\n`),0)}catch(<e>)` is the
  // non-JSON branch we patch.
  // 以 JSON 分支的 projection totalTokenCount 写出为锚（跨到非 JSON 的 stdout 写出），捕获
  // streams 对象、result 对象与 app 对象。`totalTokenCount:<app>.projection.totalTokenCount` 钉住
  // runPrompt 结果的 JSON 分支；其后的 `:(<streams>.stdout.write(`<result>\n`),0)}catch(<e>)`
  // 即为我们要打补丁的非 JSON 分支。
  // ZCode 3.8.1 may prefix that branch with the exact workspace-hook diagnostic
  // `<diagnostic>&&<writer>(<stream>,<diagnostic>),`; the writer is discovered and the
  // captured diagnostic stream is checked against stdout below.
  const exitPattern =
    /totalTokenCount:([A-Za-z_$][\w$]*)\.projection\.totalTokenCount,contextUsed:\1\.projection\.contextUsed\?\?null,contextWindow:\1\.projection\.contextWindow\?\?null\}\}\)\),0\):\((?:([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\2\),)?([A-Za-z_$][\w$]*)\.stdout\.write\(`\$\{\1\.response\}\n`\),0\)\}catch\(([A-Za-z_$][\w$]*)\)/u;
  const exit = exitPattern.exec(runtime);
  if (!exit) {
    throw new Error("ZCode runtime is incompatible with the usage-footer patch (runPrompt non-JSON exit anchor missing).");
  }
  const [match, resultVar, , , diagnosticStreamsVar, streamsVar] = exit;
  if (diagnosticStreamsVar !== undefined && diagnosticStreamsVar !== streamsVar) {
    throw new Error("ZCode runtime is incompatible with the usage-footer patch (workspace-hook diagnostic stream mismatch).");
  }
  // Discover the app object (the one with .sessionId) by looking back from the exit for the
  // `sessionId:<app>.sessionId,traceId` reference that appears in the JSON branch just above.
  // 从退出点向前回查 `sessionId:<app>.sessionId,traceId`（出现在上方的 JSON 分支里）以发现
  // app 对象（带 .sessionId 的那个）。
  const sessionIdRefPattern = new RegExp(`sessionId:([A-Za-z_$][\\w$]*)\\.sessionId,traceId`, "gu");
  let appVar: string | undefined;
  let searchFrom = exit.index;
  // Search backwards in chunks for the sessionId reference that precedes the exit.
  // 向前分块搜索位于退出点之前的 sessionId 引用。
  while (searchFrom > 0) {
    const chunkStart = Math.max(0, searchFrom - 4000);
    const chunk = runtime.slice(chunkStart, exit.index);
    const refs = [...chunk.matchAll(sessionIdRefPattern)];
    if (refs.length > 0) {
      appVar = refs[refs.length - 1][1];
      break;
    }
    searchFrom = chunkStart;
  }
  if (!appVar) {
    throw new Error("ZCode runtime is incompatible with the usage-footer patch (runPrompt app/sessionId anchor missing).");
  }

  // Build the footer-write expression, gated on ZCODE_ODW_PROTOCOL. It runs as a third element of
  // the comma sequence `(stdout.write(...), <footer>, 0)` so the function still returns 0. The
  // footer carries sessionId, the per-turn input/output (from usage if present), and the
  // projection total. All fields are optional on the launcher side. The footer string ends with a
  // literal newline: the generated source contains +"\\n" (backslash-n) so the runtime evaluates
  // "\n" to a real newline on stderr, and the launcher can split stderr lines to find it.
  // 构造 footer 写出表达式，以 ZCODE_ODW_PROTOCOL 收口。它作为逗号序列的第三项
  // `(stdout.write(...), <footer>, 0)` 执行，函数仍返回 0。footer 携带 sessionId、单轮
  // input/output（若有 usage 则取自 usage）以及 projection 总数。所有字段在 launcher 侧都是可选的。
  // footer 串以字面换行结尾：生成的源码里是 +"\\n"（反斜杠 n），使运行时把 "\n" 求值为真实换行
  // 输出到 stderr，launcher 据此按行切分 stderr 即可找到它。
  const footerWrite =
    `(process.env.ZCODE_ODW_PROTOCOL==="1"&&${streamsVar}.stderr.write(JSON.stringify({type:"zcode_usage",sessionId:${appVar}.sessionId,` +
    `totalTokens:${resultVar}.projection.totalTokenCount,` +
    `...${resultVar}.usage?{inputTokens:${resultVar}.usage.inputTokens,outputTokens:${resultVar}.usage.outputTokens}:{}})+"\\n"))`;
  // Insert the footer into the matched comma sequence. The full match spans
  // `(STREAMS.stdout.write(…),0)}catch(VAR)` — i.e. it includes the trailing catch clause. We
  // locate the `),0)` that closes the stdout.write comma-sequence, splice the footer before that
  // final `0`, and KEEP everything after `),0)` (the `}catch(VAR)`) intact. Working from the regex
  // match (not re-searching with a second regex) avoids any newline-vs-backslash-n ambiguity in
  // the original template literal.
  // 把 footer 插入匹配到的逗号序列。完整匹配跨越 `(STREAMS.stdout.write(…),0)}catch(VAR)`
  // —— 即它包含尾部的 catch 子句。我们定位结束 stdout.write 逗号序列的 `),0)`，把 footer 拼在
  // 最后那个 `0` 之前，并【保留】 `),0)` 之后的所有内容（`}catch(VAR)`）。基于正则匹配结果操作
  //（而非用第二条正则再搜），可避免原模板字面量里「真实换行 vs 反斜杠 n」的歧义。
  // Both exit branches (JSON and non-JSON) need the footer. Their anchors OVERLAP — the non-JSON
  // regex `match` begins inside the JSON branch's `…contextWindow:…??null}})),0)` text — so neither
  // string-replace-first nor regex-replace-first works cleanly (each would consume or shift the
  // other's anchor). Instead we compute BOTH edits as absolute index ranges in the ORIGINAL runtime
  // and apply them right-to-left (later index first) so earlier indices stay valid. The two ranges
  // are disjoint in what they REPLACE: the JSON edit inserts at the `,0)` of the JSON branch; the
  // non-JSON edit replaces the non-JSON branch's `(stdout.write(…),0)}catch(VAR)`.
  // 两个退出分支（JSON 与非 JSON）都需要 footer。它们的锚点【重叠】——非 JSON 正则 match 起点位于
  // JSON 分支的 `…contextWindow:…??null}})),0)` 文本内部——所以「先 replace 字符串」或「先 replace
  // 正则」都不干净（各自会吃掉或挪动对方的锚点）。改为：把两处编辑都算成原始 runtime 里的绝对
  // 下标区间，然后【从右到左】应用（先做下标靠后的），使靠前的下标保持有效。两处区间在「被替换
  // 内容」上是互不相交的：JSON 编辑在 JSON 分支的 `,0)` 处插入；非 JSON 编辑替换非 JSON 分支的
  // `(stdout.write(…),0)}catch(VAR)`。
  const tail = `),0)`;
  const tailIdx = match.lastIndexOf(tail);
  if (tailIdx < 0) {
    throw new Error("ZCode runtime is incompatible with the usage-footer patch (runPrompt exit comma-tail missing).");
  }
  // Non-JSON edit: absolute range [matchStart + tailIdx, matchStart + tailIdx + tail.length) → footer.
  // 非 JSON 编辑：绝对区间 [matchStart + tailIdx, matchStart + tailIdx + tail.length) → footer。
  const nonJsonStart = exit.index + tailIdx;
  const nonJsonReplacement = `),${footerWrite},0)`;

  // Structured-output edits: insert the footer before each projection-bearing `,0)` exit. 3.8.1
  // wrote `Sl({...??null}})),0)`; 3.10.2 kept that shape for the formatted (`pc`) branch and
  // added a JSON.stringify template branch that ends `...??null}})}\n`),0)`.
  // 结构化输出编辑：在每个带 projection 的 `,0)` 出口前插入 footer。3.8.1 写
  // `Sl({...??null}})),0)`；3.10.2 把该形态留给 formatted（`pc`）分支，并新增以
  // `...??null}})}\n`),0)` 结尾的 JSON.stringify 模板分支。
  const jsonInsertion = `,${footerWrite}`;
  const jsonTails = [
    `contextWindow:${resultVar}.projection.contextWindow??null}})),0)`,
    `contextWindow:${resultVar}.projection.contextWindow??null}})}\n` + "`),0)"
  ];
  const edits: Array<{ start: number; end: number; text: string }> = [
    { start: nonJsonStart, end: nonJsonStart + tail.length, text: nonJsonReplacement }
  ];
  for (const needle of jsonTails) {
    let from = 0;
    while (from < runtime.length) {
      const idx = runtime.indexOf(needle, from);
      if (idx < 0) break;
      const insertAt = idx + needle.length - 3;
      if (insertAt !== nonJsonStart) {
        edits.push({ start: insertAt, end: insertAt, text: jsonInsertion });
      }
      from = idx + needle.length;
    }
  }
  edits.sort((left, right) => right.start - left.start);

  let patched = runtime;
  for (const edit of edits) {
    patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  }
  return patched;
}

export function patchRuntimeOAuthHttpErrors(runtime: string): string {
  if (runtime.includes("empty or non-JSON response")) return runtime;
  if (!runtime.includes('"OAuth response is not valid JSON",{httpStatus:void 0}')) return runtime;

  const parserPattern = /function ([A-Za-z_$][\w$]*)\(e\)\{try\{return JSON\.parse\(e\)\}catch\{throw new ([A-Za-z_$][\w$]*)\("OAuth response is not valid JSON",\{httpStatus:void 0\}\)\}\}/u;
  const parser = parserPattern.exec(runtime);
  if (!parser) {
    throw new Error("ZCode runtime is incompatible with the OAuth HTTP error patch (parser anchor missing).");
  }
  const [, parserName, errorName] = parser;
  const decoderPattern = new RegExp(
    `([A-Za-z_$][\\w$]*)=new TextDecoder\\(\\)\\.decode\\(([A-Za-z_$][\\w$]*)\\.body\\),([A-Za-z_$][\\w$]*)=${parserName}\\(\\1\\)`,
    "u"
  );
  const decoder = decoderPattern.exec(runtime);
  if (!decoder) {
    throw new Error("ZCode runtime is incompatible with the OAuth HTTP error patch (status anchor missing).");
  }
  const [, bodyName, responseName, parsedName] = decoder;
  const withStatus = runtime.replace(
    decoder[0],
    `${bodyName}=new TextDecoder().decode(${responseName}.body),${parsedName}=${parserName}(${bodyName},${responseName}.status)`
  );
  return withStatus.replace(
    parser[0],
    `function ${parserName}(e,t){try{return JSON.parse(e)}catch{let r=typeof t=="number"&&(t<200||t>=300)?\`OAuth HTTP error \${t} (empty or non-JSON response)\`:"OAuth response is not valid JSON";throw new ${errorName}(r,{httpStatus:t})}}`
  );
}

/** Avoid Undici rejecting bodies on the Fetch statuses that must be bodyless. */
export function hasRuntimeHttpNoContentGuard(runtime: string): boolean {
  return /([A-Za-z_$][\w$]*)\.statusCode===204\|\|\1\.statusCode===205\|\|\1\.statusCode===304\?void 0:/u
    .test(runtime);
}

export function patchRuntimeHttpNoContent(runtime: string): string {
  const responsePattern = /new Response\(([A-Za-z_$][\w$]*)\.Readable\.toWeb\(([A-Za-z_$][\w$]*)\),\{headers:([A-Za-z_$][\w$]*),status:\2\.statusCode\?\?502,statusText:\2\.statusMessage\}\)/gu;
  let changed = false;
  const patched = runtime.replace(
    responsePattern,
    (_match, readableNamespace: string, response: string, headers: string) => {
      changed = true;
      return `new Response(${response}.statusCode===204||${response}.statusCode===205||${response}.statusCode===304?void 0:${readableNamespace}.Readable.toWeb(${response}),{headers:${headers},status:${response}.statusCode??502,statusText:${response}.statusMessage})`;
    }
  );
  return changed ? patched : runtime;
}

function escapeRegExpName(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function countRegExpMatches(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return Array.from(source.matchAll(new RegExp(pattern.source, flags))).length;
}

/** Detect the local transport classifier while preserving the emitted-output retry boundary. */
export function hasRuntimeNetworkRetryGuard(runtime: string): boolean {
  return runtime.includes("var $zTransportCodes=[")
    && runtime.includes("function $zTransportCode(e){")
    && runtime.includes("function $zTransportChain(e,t){")
    && /if\(\$zTransportChain\(e,new WeakSet\)\)return!0;return [A-Za-z_$][\w$]*\(e\)\}/u.test(runtime)
    && /\|\|\$zTransportChain\([A-Za-z_$][\w$]*,new WeakSet\)\)return\{code:/u.test(runtime)
    && /\|\|\$zTransportChain\([A-Za-z_$][\w$]*,new WeakSet\)\)return!0;if\(t!==void 0\)return!1;/u.test(runtime)
    && /function [A-Za-z_$][\w$]*\(e\)\{return e\.emittedRetryBoundaryEvent\|\|e\.attempt>=e\.maxAttempts\|\|e\.failure\.reason===[A-Za-z_$][\w$]*\.Cancelled\?!1:/u.test(runtime);
}

/**
 * Recover transport failures whose deep `cause.code` is hidden by a wrapping
 * `model_request_failed` code. The emitted-output gate remains unchanged: once
 * content is visible, the turn-level stream recovery owns discard/anchor logic.
 */
export function patchRuntimeNetworkRetryClassification(runtime: string): string {
  if (hasRuntimeNetworkRetryGuard(runtime)) return runtime;
  if (runtime.includes("function $zTransportCode(e){")
    || runtime.includes("function $zTransportChain(e,t){")) {
    throw new Error("ZCode runtime contains a partial network retry patch.");
  }

  const whitelistPattern = /function ([A-Za-z_$][\w$]*)\(e\)\{let t=e\?\.toUpperCase\(\);return t==="ECONNRESET"\|\|t==="ECONNREFUSED"\|\|t==="EAI_AGAIN"\|\|t==="ENOTFOUND"\|\|t==="ENETUNREACH"\|\|t==="EHOSTUNREACH"\|\|t==="UND_ERR_SOCKET"\|\|t==="UND_ERR_CONNECT_TIMEOUT"\}/u;
  const extractorPattern = /function ([A-Za-z_$][\w$]*)\(e\)\{return ([A-Za-z_$][\w$]*)\(e,new WeakSet\)\}function \2\(e,t\)\{if\(([A-Za-z_$][\w$]*)\(e,t\)\)return;let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(e\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\4,"code"\);if\(\6\)return \6;let [A-Za-z_$][\w$]*=\4\.cause;if\([A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*!==e\)return \2\([A-Za-z_$][\w$]*,t\)\}/u;
  const classifierPattern = /function ([A-Za-z_$][\w$]*)\(e,t\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(e\),[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(\2\),([A-Za-z_$][\w$]*)=EXTRACTOR\(\2\),/u;
  const streamGatePattern = /function ([A-Za-z_$][\w$]*)\(e\)\{return e\.emittedRetryBoundaryEvent\|\|e\.attempt>=e\.maxAttempts\|\|e\.failure\.reason===([A-Za-z_$][\w$]*)\.Cancelled\?!1:/u;

  const whitelistMatch = whitelistPattern.exec(runtime);
  const extractorMatch = extractorPattern.exec(runtime);
  if (!whitelistMatch || !extractorMatch) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (error-code anchors missing).");
  }

  const whitelist = whitelistMatch[1]!;
  const extractor = extractorMatch[1]!;
  const seen = extractorMatch[3]!;
  const normalizer = extractorMatch[5]!;
  const stringGetter = extractorMatch[7]!;
  const classifierFullPattern = new RegExp(
    classifierPattern.source.replace("EXTRACTOR", escapeRegExpName(extractor)),
    "u"
  );
  const classifier = classifierFullPattern.exec(runtime);
  if (!classifier) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (classifier anchor missing).");
  }
  const classifierError = classifier[2]!;
  const classifierCode = classifier[3]!;

  const networkBranchPattern = new RegExp(
    `if\\(${escapeRegExpName(whitelist)}\\(${escapeRegExpName(classifierCode)}\\)\\)return\\{code:([A-Za-z_$][\\w$]*)\\.ModelRequestFailed,message:"Network connection failed for the provider request\\."`,
    "u"
  );
  const networkBranch = networkBranchPattern.exec(runtime);
  const classifierEnd = runtime.indexOf("function ", classifier.index + classifier[0].length);
  if (!networkBranch || networkBranch.index < classifier.index
    || (classifierEnd >= 0 && networkBranch.index >= classifierEnd)) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (network branch anchor missing).");
  }

  const retryDecisionPattern = new RegExp(
    `function ([A-Za-z_$][\\w$]*)\\(e,t\\)\\{if\\(t\\)\\{if\\(${escapeRegExpName(whitelist)}\\(t\\)\\|\\|([A-Za-z_$][\\w$]*)\\.has\\(t\\)\\)return!0;let ([A-Za-z_$][\\w$]*)=t\\.toLowerCase\\(\\);if\\(\\3==="network_error"\\|\\|\\3==="network_error_retryable"\\)return!0\\}return ([A-Za-z_$][\\w$]*)\\(e\\)\\}`,
    "u"
  );
  const retryDecision = retryDecisionPattern.exec(runtime);
  if (!retryDecision) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (retry decision anchor missing).");
  }

  const staleStreamPattern = new RegExp(
    `function ([A-Za-z_$][\\w$]*)\\(e,t\\)\\{let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(e\\);if\\(([A-Za-z_$][\\w$]*)\\(\\2\\)\\|\\|([A-Za-z_$][\\w$]*)\\(${escapeRegExpName(extractor)}\\(\\2\\)\\)\\)return!0;`,
    "u"
  );
  const staleStream = staleStreamPattern.exec(runtime);
  if (!staleStream) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (stale stream anchor missing).");
  }

  for (const [pattern, label] of [
    [whitelistPattern, "network error-code whitelist"],
    [extractorPattern, "cause-chain error-code extractor"],
    [classifierFullPattern, "model request failure classifier"],
    [networkBranchPattern, "classifier network branch"],
    [retryDecisionPattern, "final retry decision"],
    [staleStreamPattern, "stale stream detector"],
    [streamGatePattern, "emitted-output stream gate"]
  ] as const) {
    if (countRegExpMatches(runtime, pattern) !== 1) {
      throw new Error(`ZCode runtime is incompatible with the network retry patch (${label} is not unique).`);
    }
  }

  const transportCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
    "CONNECTIONCLOSED",
    "ETIMEDOUT",
    "ETIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"
  ];
  const transportText = JSON.stringify(transportCodes);
  const chainProbe = [
    `var $zTransportCodes=${transportText};`,
    "function $zTransportCode(e){let t=e?.trim().toUpperCase();return!!t&&$zTransportCodes.includes(t)}",
    "function $zTransportText(e){let t=e?.toUpperCase();return!!t&&$zTransportCodes.some(r=>t.includes(r))}",
    `function $zTransportChain(e,t){if(${seen}(e,t))return!1;let r=${normalizer}(e),n=${normalizer}(r.error),o=${normalizer}(r.context);if($zTransportCode(${stringGetter}(r,"code"))||$zTransportCode(${stringGetter}(r,"providerCode"))||$zTransportCode(${stringGetter}(n,"code"))||$zTransportCode(${stringGetter}(n,"providerCode"))||$zTransportCode(${stringGetter}(o,"code"))||$zTransportCode(${stringGetter}(o,"providerCode"))||$zTransportText(${stringGetter}(r,"message"))||$zTransportText(${stringGetter}(n,"message"))||$zTransportText(${stringGetter}(o,"message")))return!0;let i=r.cause;return i&&i!==e?$zTransportChain(i,t):!1}`
  ].join("");

  let patched = runtime.replace(
    retryDecisionPattern,
    (_match, decision: string, reasonSet: string, reason: string, fallback: string) => (
      `${chainProbe}function ${decision}(e,t){if(t){if(${whitelist}(t)||${reasonSet}.has(t))return!0;let ${reason}=t.toLowerCase();if(${reason}==="network_error"||${reason}==="network_error_retryable")return!0}if($zTransportChain(e,new WeakSet))return!0;return ${fallback}(e)}`
    )
  );
  patched = patched.replace(
    networkBranchPattern,
    (_match, codeEnum: string) => `if(${whitelist}(${classifierCode})||$zTransportChain(${classifierError},new WeakSet))return{code:${codeEnum}.ModelRequestFailed,message:"Network connection failed for the provider request."`
  );
  patched = patched.replace(
    staleStreamPattern,
    (_match, detector: string, error: string, unwrap: string, idle: string, staleCode: string) => (
      `function ${detector}(e,t){let ${error}=${unwrap}(e);if(${idle}(${error})||${staleCode}(${extractor}(${error}))||$zTransportChain(${error},new WeakSet))return!0;`
    )
  );

  if (!hasRuntimeNetworkRetryGuard(patched)) {
    throw new Error("ZCode runtime network retry patch failed postcondition verification.");
  }
  return patched;
}

export function patchRuntimeZaiDesktopOAuth(runtime: string): string {
  if (runtime.includes('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"')) return runtime;

  const credentialMarker = ".saveZaiLoginCredentials({accessToken:";
  const markerIndex = runtime.indexOf(credentialMarker);
  if (markerIndex < 0) {
    throw new Error("ZCode runtime is incompatible with the Desktop OAuth patch (credential anchor missing).");
  }
  const functionStart = runtime.lastIndexOf("async function ", markerIndex);
  const nextFunction = runtime.indexOf("async function ", markerIndex + credentialMarker.length);
  if (functionStart < 0 || nextFunction < 0) {
    throw new Error("ZCode runtime is incompatible with the Desktop OAuth patch (function anchor missing).");
  }
  const originalFunction = runtime.slice(functionStart, nextFunction);
  const prefix = /^async function ([A-Za-z_$][\w$]*)\(e=\{\}\)\{/u.exec(originalFunction);
  const abortHelper = /;([A-Za-z_$][\w$]*)\(e\.abortSignal\);let/u.exec(originalFunction)?.[1];
  const credentialStore = /e\.credentialStore\?\?([A-Za-z_$][\w$]*)\(\{env:[A-Za-z_$][\w$]*\}\)/u.exec(originalFunction)?.[1];
  const loginError = /new ([A-Za-z_$][\w$]*)\("credential_write_failed"/u.exec(originalFunction)?.[1];
  const apiKeyResolver = /await ([A-Za-z_$][\w$]*)\(\{accessToken:[^,]+,env:[^,]+,httpClient:e\.httpClient,providerId:"zai"/u.exec(originalFunction)?.[1];
  const configWriter = /await ([A-Za-z_$][\w$]*)\(\{apiKey:[^,]+,filePath:e\.userConfigPath,providerId:"zai"\}\)/u.exec(originalFunction)?.[1];
  const httpClientFactory = /e\.httpClient\?\?([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*=e\.state\?\?/u.exec(runtime)?.[1];
  if (!prefix || !abortHelper || !credentialStore || !loginError
    || !apiKeyResolver || !configWriter || !httpClientFactory) {
    throw new Error("ZCode runtime is incompatible with the Desktop OAuth patch (dependency anchor missing).");
  }

  const branch = [
    'if((e.env??process.env).ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"){',
    "let $zEnv=e.env??process.env;",
    `${abortHelper}(e.abortSignal);`,
    `let $zStore=e.credentialStore??${credentialStore}({env:$zEnv}),$zHttp=e.httpClient??${httpClientFactory}($zEnv),$zPayload;`,
    `try{$zPayload=JSON.parse(require("node:fs").readFileSync(0,"utf8"))}catch($zError){throw new ${loginError}("invalid_callback","Unable to read the Z.AI OAuth callback.",{cause:$zError})}`,
    `if(!$zPayload||typeof $zPayload.callbackUrl!=="string"||typeof $zPayload.state!=="string")throw new ${loginError}("invalid_callback","The Z.AI OAuth callback payload is invalid.");`,
    "let $zUrl;",
    `try{$zUrl=new URL($zPayload.callbackUrl)}catch($zError){throw new ${loginError}("invalid_callback","The Z.AI OAuth callback URL is invalid.",{cause:$zError})}`,
    `if($zUrl.protocol!=="zcode:"||$zUrl.hostname!=="zai-auth"||$zUrl.pathname.replace(/\\/+$/u,"")!=="/callback")throw new ${loginError}("invalid_callback","The Z.AI OAuth callback target is invalid.");`,
    "let $zCode=$zUrl.searchParams.get(\"code\")??$zUrl.searchParams.get(\"authCode\"),$zState=$zUrl.searchParams.get(\"state\");",
    `if(!$zCode||!$zState||$zState!==$zPayload.state)throw new ${loginError}("invalid_callback","The Z.AI OAuth callback state is invalid or expired.");`,
    "let $zResponse=await $zHttp.request({maxResponseBytes:65536,body:new TextEncoder().encode(JSON.stringify({provider:\"zai\",code:$zCode,redirect_uri:\"zcode://zai-auth/callback\",state:$zState})),headers:{\"Content-Type\":\"application/json\"},method:\"POST\",trace:e.trace,url:\"https://zcode.z.ai/api/v1/oauth/token\"},e.abortSignal),$zText=new TextDecoder().decode($zResponse.body),$zEnvelope;",
    `try{$zEnvelope=JSON.parse($zText)}catch($zError){throw new ${loginError}("token_exchange_failed",$zResponse.status<200||$zResponse.status>=300?"OAuth HTTP error "+$zResponse.status+" (empty or non-JSON response)":"OAuth response is not valid JSON",{cause:$zError})}`,
    "let $zMessage=typeof $zEnvelope?.msg===\"string\"&&$zEnvelope.msg.trim()?$zEnvelope.msg.trim():void 0;",
    `if($zResponse.status<200||$zResponse.status>=300)throw new ${loginError}("token_exchange_failed",$zMessage??"OAuth HTTP error "+$zResponse.status);`,
    `if($zEnvelope?.code!==0)throw new ${loginError}("token_exchange_failed",$zMessage??"Z.AI token exchange failed.");`,
    "let $zData=$zEnvelope.data,$zAccessToken=$zData?.zai?.access_token,$zJwtToken=$zData?.token,$zUser=$zData?.user;",
    `if(typeof $zAccessToken!=="string"||typeof $zJwtToken!=="string"||!$zUser||typeof $zUser!=="object")throw new ${loginError}("token_exchange_failed","Z.AI token response is missing credentials or user data.");`,
    `${abortHelper}(e.abortSignal);`,
    `try{await $zStore.saveZaiLoginCredentials({accessToken:$zAccessToken,jwtToken:$zJwtToken,user:$zUser})}catch($zError){throw new ${loginError}("credential_write_failed","Login succeeded but writing credentials failed.",{cause:$zError})}`,
    `let $zApiKey=await ${apiKeyResolver}({accessToken:$zAccessToken,env:$zEnv,httpClient:$zHttp,providerId:"zai",resolver:e.apiKeyResolver}),$zConfig;`,
    `try{$zConfig=await ${configWriter}({apiKey:$zApiKey,filePath:e.userConfigPath,providerId:"zai"})}catch($zError){throw new ${loginError}("config_update_failed","Login succeeded but updating ZCode config failed.",{cause:$zError})}`,
    'return{configPath:$zConfig.path,credentialsPath:$zStore.filePath,model:$zConfig.mainModel,providerId:"zai",user:$zUser}',
    "}"
  ].join("");
  const insertionPoint = functionStart + prefix[0].length;
  return `${runtime.slice(0, insertionPoint)}${branch}${runtime.slice(insertionPoint)}`;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, { ...init, redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response.text();
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  const writer = Bun.file(destination).writer({ highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of response.body) {
      await writer.write(chunk);
    }
  } finally {
    await writer.end();
  }
}

async function sha512Base64(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; capture?: boolean } = {}
): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: "inherit",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit"
  });
  const stdoutPromise = options.capture
    ? new Response(child.stdout as ReadableStream<Uint8Array>).text()
    : Promise.resolve("");
  const [code, stdout] = await Promise.all([child.exited, stdoutPromise]);
  if (code !== 0) throw new Error(`${command} exited with status ${code}`);
  return stdout.trim();
}

async function installLocalTui(nextVendor: string): Promise<void> {
  const source = join(root, "packages", "zcode-tui");
  const entry = join(source, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error("Local @zcode/tui is not built; run `bun run build:tui` first.");
  }
  const target = join(nextVendor, "node_modules", "@zcode", "tui");
  await mkdir(target, { recursive: true });
  await cp(join(source, "package.json"), join(target, "package.json"));
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
}

/** Align Coding Plan defaults without depending on platform-specific minifier names. */
export function patchRuntimeLoginModelDefaults(runtime: string): string {
  const presetPattern = /([A-Za-z_$][\w$]*)="zai\/glm-(?:5\.1|5\.2)",([A-Za-z_$][\w$]*)="zai\/glm-(?:4\.7|5-turbo)",([A-Za-z_$][\w$]*)="bigmodel\/glm-(?:5\.1|5\.2)",([A-Za-z_$][\w$]*)="bigmodel\/glm-4\.7"/u;
  const modelIdPattern = /([A-Za-z_$][\w$]*)="glm-(?:5\.1|5\.2)",([A-Za-z_$][\w$]*)="glm-(?:4\.7|5-turbo)"/u;
  const modelEntriesPattern = /models:\{\.\.\.([A-Za-z_$][\w$]*),\[([A-Za-z_$][\w$]*)\]:\{\.\.\.([A-Za-z_$][\w$]*),name:"GLM-5\.(?:1|2)"\},\[([A-Za-z_$][\w$]*)\]:\{\.\.\.([A-Za-z_$][\w$]*),name:"GLM-(?:4\.7|5-Turbo)"\}(?:,\["glm-5-turbo"\]:\{\.\.\.\1\["glm-5-turbo"\],name:"GLM-5-Turbo"\})?\}/u;
  const legacyLiteSelectionPattern = /([A-Za-z_$][\w$]*)=typeof ([A-Za-z_$][\w$]*)\.lite=="string"\?\2\.lite:([A-Za-z_$][\w$]*)\.liteModel/u;
  const scopedLiteSelectionPattern = /([A-Za-z_$][\w$]*)=typeof ([A-Za-z_$][\w$]*)\.lite=="string"&&\2\.lite\.startsWith\(([A-Za-z_$][\w$]*)\.mainModel\.slice\(0,\3\.mainModel\.indexOf\("\/"\)\+1\)\)\?\2\.lite:\3\.liteModel/u;

  const preset = presetPattern.exec(runtime);
  const modelIds = modelIdPattern.exec(runtime);
  const modelEntries = modelEntriesPattern.exec(runtime);
  if (!preset || !modelIds || !modelEntries
    || modelIds[1] !== modelEntries[2]
    || modelIds[2] !== modelEntries[4]) {
    throw new Error("ZCode runtime is incompatible with the login model defaults patch (model preset/catalog anchors missing).");
  }

  let patched = runtime
    .replace(
      preset[0],
      `${preset[1]}="zai/glm-5.2",${preset[2]}="zai/glm-5-turbo",${preset[3]}="bigmodel/glm-5.2",${preset[4]}="bigmodel/glm-4.7"`
    )
    .replace(modelIds[0], `${modelIds[1]}="glm-5.2",${modelIds[2]}="glm-4.7"`)
    .replace(
      modelEntries[0],
      `models:{...${modelEntries[1]},[${modelEntries[2]}]:{...${modelEntries[3]},name:"GLM-5.2"},[${modelEntries[4]}]:{...${modelEntries[5]},name:"GLM-4.7"},["glm-5-turbo"]:{...${modelEntries[1]}["glm-5-turbo"],name:"GLM-5-Turbo"}}`
    );

  const legacyLiteSelection = legacyLiteSelectionPattern.exec(patched);
  if (legacyLiteSelection) {
    const [, selection, model, selectedPreset] = legacyLiteSelection;
    patched = patched.replace(
      legacyLiteSelection[0],
      `${selection}=typeof ${model}.lite=="string"&&${model}.lite.startsWith(${selectedPreset}.mainModel.slice(0,${selectedPreset}.mainModel.indexOf("/")+1))?${model}.lite:${selectedPreset}.liteModel`
    );
  } else if (!scopedLiteSelectionPattern.test(patched)) {
    throw new Error("ZCode runtime is incompatible with the login model defaults patch (lite model anchor missing).");
  }
  return patched;
}

const goalFailurePauseMarker = /finishTargetTurnAccounting\(\{[^{}]*?status:"paused",traceContext:/u;
const terminalProjectionMarkers = [
  'status:"idle",currentTurnId:void 0,activeToolCalls:[],totalTokenCount:',
  'status:"error",currentTurnId:void 0,activeToolCalls:[],lastError:'
] as const;

export const runtimePatchPlan: readonly RuntimePatchDefinition[] = [
  {
    id: "tui-bridge",
    requirement: "required",
    apply: patchRuntimeTuiBridge,
    verify: (runtime) => runtime.includes(".readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ")
      && runtime.includes(".loadSessionContextMessages=async()=>await(await")
  },
  {
    id: "usage-footer",
    requirement: "required",
    apply: patchRuntimeUsageFooter,
    verify: (runtime) => runtime.includes("zcode_usage")
  },
  {
    id: "goal-failure-pause",
    requirement: "optional",
    apply: patchRuntimeGoalFailurePause,
    verify: (runtime) => goalFailurePauseMarker.test(runtime)
  },
  {
    id: "terminal-tool-projection",
    requirement: "optional",
    apply: patchRuntimeTerminalToolProjection,
    verify: (runtime) => terminalProjectionMarkers.every((marker) => runtime.includes(marker))
  },
  {
    id: "detached-agent-lifecycle",
    requirement: "optional",
    apply: patchRuntimeDetachedAgentLifecycle,
    verify: (runtime) => runtime.includes("Detached background agent lifecycle failed")
  },
  {
    id: "agent-auto-background",
    requirement: "optional",
    apply: patchRuntimeAgentAutoBackground,
    verify: (runtime) => runtime.includes(
      "autoBackgroundMs:this.config.subagents?.autoBackgroundMs??1e3,outputRootDir:"
    )
  },
  {
    id: "http-no-content",
    requirement: "required",
    apply: patchRuntimeHttpNoContent,
    verify: hasRuntimeHttpNoContentGuard
  },
  {
    id: "network-retry-classification",
    requirement: "required",
    apply: patchRuntimeNetworkRetryClassification,
    verify: hasRuntimeNetworkRetryGuard
  },
  {
    id: "oauth-http-errors",
    requirement: "optional",
    apply: patchRuntimeOAuthHttpErrors,
    verify: (runtime) => !runtime.includes('"OAuth response is not valid JSON",{httpStatus:void 0}')
  },
  {
    id: "desktop-oauth",
    requirement: "required",
    apply: patchRuntimeZaiDesktopOAuth,
    verify: (runtime) => runtime.includes('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"')
  },
  {
    id: "login-model-defaults",
    requirement: "required",
    apply: patchRuntimeLoginModelDefaults
  },
  {
    // 3.8.1 minified aggregator/projection names (`aSi`/`oSi`/`nSi`) moved again in 3.10.2.
    // The original token-write bug is already fixed upstream; skip rather than fail the sync.
    id: "context-cache-from-parts",
    requirement: "optional",
    apply: patchRuntimeContextCacheFromParts,
    verify: (runtime) => runtime.includes("$ctxPartTokens")
      && runtime.includes("nSi(e.projection,t?.cache)??t")
  },
  {
    id: "route-selection",
    requirement: "required",
    apply: patchRuntimeRouteSelection,
    verify: (runtime) => runtime.includes("function __zcodeResolveAdvisorRolePolicy")
      && runtime.includes("ZCODE_RUNTIME_ROUTE_UNSUPPORTED_THOUGHT_LEVEL")
      && runtime.includes('__zcodeRoutePolicySource:"parent"')
  },
  {
    id: "runtime-attestation",
    requirement: "required",
    apply: patchRuntimeAttestation,
    verify: (runtime) => runtime.includes("function __zcodeRuntimeAttestation")
      && runtime.includes("ZCODE_ODW_RUNTIME_ATTESTATION")
      && runtime.includes('type:"zcode_runtime_attestation"')
  },
  {
    id: "strict-advisor-hooks",
    requirement: "required",
    apply: patchRuntimeStrictAdvisorHooks,
    verify: (runtime) => runtime.includes("function __zcodeIsStrictAdvisorHook")
      && runtime.includes("function __zcodeStrictAdvisorHookFailureMessage")
      && runtime.includes("ZCODE_STRICT_ADVISOR_HOOK_FAILURE")
      && runtime.includes("let _zcodeSendResult=await t.app.sendInput({attachments:")
  },
  {
    id: "cli-help-contract",
    requirement: "required",
    apply: patchRuntimeCliHelpContract,
    verify: hasRuntimeCliHelpContract
  }
];

export function applyRuntimePatchPlan(
  runtime: string,
  patches: readonly RuntimePatchDefinition[] = runtimePatchPlan
): { runtime: string; reports: RuntimePatchReport[] } {
  let patched = runtime;
  const reports: RuntimePatchReport[] = [];
  for (const patch of patches) {
    try {
      const next = patch.apply(patched);
      if (patch.apply(next) !== next) {
        throw new Error("patch is not idempotent");
      }
      if (patch.verify && !patch.verify(next)) {
        throw new Error("postcondition verification failed");
      }
      reports.push({
        id: patch.id,
        requirement: patch.requirement,
        status: next === patched ? "already_present" : "applied"
      });
      patched = next;
    } catch (error) {
      const report: RuntimePatchReport = {
        id: patch.id,
        requirement: patch.requirement,
        status: patch.requirement === "required" ? "failed" : "skipped",
        message: error instanceof Error ? error.message : String(error)
      };
      reports.push(report);
      if (patch.requirement === "required") {
        throw new RuntimePatchError(patch, error, reports);
      }
    }
  }
  return { runtime: patched, reports };
}

/**
 * Repair `/context` cache stats for historical sessions whose assistant messages
 * carry zero tokens (pre-3.8.1 runtimes never persisted them on the main-turn path).
 *
 * The 3.8.1 runtime renamed the aggregator `mda`→`aSi`, the coercion helper
 * `zRe`→`YRe`, and the projection `LRe`→`oSi`. The token-write bug itself is
 * fixed at the source (the step-finish handler now calls `persistAssistantMessage`
 * with `tokens:Tq(r.result.usage)`), so this patch only needs the read-path
 * fallback: when an assistant message's `info.tokens` are all zero, fall back to
 * the last `step-finish` part that carries positive token counts.
 */
export function patchRuntimeContextCacheFromParts(runtime: string): string {
  const aggregateAnchor =
    'function aSi(e){let t=0,r=0,n=0,o=0,i=0,a=0,u=0;for(let l of e){if(l.info.role!=="assistant"||l.info.summary)continue;let c=YRe(l.info.tokens.input)??0,d=YRe(l.info.tokens.cache.read)??0,p=YRe(l.info.tokens.cache.write)??0;c<=0&&d<=0&&p<=0||(o+=1,t+=c,r+=d,n+=p,i=c,a=d,u=p)}';
  const projectionAnchor =
    'function oSi(e,t){if(t<=0)return;let r=aSi(e);for(let n=e.length-1;n>=0;n-=1){let o=e[n];if(!o)continue;if(o.info.role==="user"&&o.info.summary){let a=o.parts.find(u=>u.type==="compaction"&&u.compactBoundary);if(a?.type==="compaction"&&a.compactBoundary){let u=Loe(a.compactBoundary.truePostCompactTokenCount??a.compactBoundary.postCompactTokenCount);if(u!==void 0)return{cost:null,size:t,used:u}}}if(o.info.role!=="assistant"||o.info.summary)continue;let i=iSi(o.info.tokens);if(i!==void 0)return{...r?{cache:r}:{},cost:null,size:t,used:i}}}';
  const projectionCallerAnchor =
    'function t5e(e){let t=oSi(e.messages,e.projection.contextWindow);return Xki(nSi(e.projection,t?.used===e.projection.contextUsed?t.cache:void 0)??t,eSi(e.persistedContextUsageBreakdownEvents??[]))}';
  const projectionCallerMarker = "nSi(e.projection,t?.cache)??t";
  let patched = runtime;
  if (!patched.includes("$ctxPartTokens")) {
    const anchorIndex = patched.indexOf(aggregateAnchor);
    if (anchorIndex < 0) {
      throw new Error("ZCode runtime is incompatible with the context-cache patch (aggregator anchor missing).");
    }
    const fallbackHelper = [
      "let $ctxPartTokens=function(l){",
      'let f=Array.isArray(l.parts)?l.parts.filter(function(x){return x&&x.type==="step-finish"&&x.tokens}):[];',
      "for(let k=f.length-1;k>=0;k-=1){",
      "let g=f[k].tokens||{},h=YRe(g.input)??0,y=YRe(g.cache&&g.cache.read)??0,w=YRe(g.cache&&g.cache.write)??0;",
      "if(h>0||y>0||w>0)return{input:h,cache:{read:y,write:w}};}",
      "return null};",
      'let $ctxMsgTokens=function(l){let q=l.info.tokens;return q&&typeof q=="object"?{input:YRe(q.input)??0,cache:{read:YRe(q.cache&&q.cache.read)??0,write:YRe(q.cache&&q.cache.write)??0}}:{input:0,cache:{read:0,write:0}}};'
    ].join("");
    const replacement = `function aSi(e){${fallbackHelper}let t=0,r=0,n=0,o=0,i=0,a=0,u=0;for(let l of e){if(l.info.role!=="assistant"||l.info.summary)continue;let v=$ctxPartTokens(l),m=$ctxMsgTokens(l);let c=m.input,d=m.cache.read,p=m.cache.write;if((c<=0&&d<=0&&p<=0)&&v){c=v.input;d=v.cache.read;p=v.cache.write}c<=0&&d<=0&&p<=0||(o+=1,t+=c,r+=d,n+=p,i=c,a=d,u=p)}`;
    patched = patched.slice(0, anchorIndex) + replacement + patched.slice(anchorIndex + aggregateAnchor.length);
  }
  if (!patched.includes("$ctxCache")) {
    if (!patched.includes(projectionAnchor)) {
      throw new Error("ZCode runtime is incompatible with the context-cache patch (projection anchor missing).");
    }
    patched = patched.replace(
      projectionAnchor,
      'function oSi(e,t){if(t<=0)return;let $ctxCache=aSi(e);for(let n=e.length-1;n>=0;n-=1){let o=e[n];if(!o)continue;if(o.info.role==="user"&&o.info.summary){let a=o.parts.find(u=>u.type==="compaction"&&u.compactBoundary);if(a?.type==="compaction"&&a.compactBoundary){let u=Loe(a.compactBoundary.truePostCompactTokenCount??a.compactBoundary.postCompactTokenCount);if(u!==void 0)return{...$ctxCache?{cache:$ctxCache}:{},cost:null,size:t,used:u}}}if(o.info.role!=="assistant"||o.info.summary)continue;let i=iSi(o.info.tokens);if(i!==void 0)return{...$ctxCache?{cache:$ctxCache}:{},cost:null,size:t,used:i}}return $ctxCache?{...$ctxCache?{cache:$ctxCache}:{},cost:null,size:t,used:void 0}:void 0}'
    );
  }
  // The projection caller (t5e) has its own marker so a partial application
  // (oSi patched but t5e not) is still detected instead of silently skipped.
  if (!patched.includes(projectionCallerMarker)) {
    if (!patched.includes(projectionCallerAnchor)) {
      throw new Error("ZCode runtime is incompatible with the context-cache patch (projection caller anchor missing).");
    }
    patched = patched.replace(
      projectionCallerAnchor,
      'function t5e(e){let t=oSi(e.messages,e.projection.contextWindow);return Xki(nSi(e.projection,t?.cache)??t,eSi(e.persistedContextUsageBreakdownEvents??[]))}'
    );
  }
  return patched;
}

/** Apply exact main/lite reasoning levels and persist immutable Advisor role routing. */
export function patchRuntimeRouteSelection(runtime: string): string {
  const marker = "function __zcodeResolveAdvisorRolePolicy";
  const requiredMarkers = [
    marker,
    "ZCODE_RUNTIME_ROUTE_UNSUPPORTED_THOUGHT_LEVEL",
    "__zcodeRolePolicy",
    'n.startsWith("sol-advisor@")',
    "this.sessionPersisted=!0;let __zcodePersistPolicy=this.config.__zcodeRolePolicy",
    "hooks:this.config.hooks",
    '__zcodeRoutePolicySource:"parent"'
  ];
  if (runtime.includes(marker)) {
    if (requiredMarkers.every((value) => runtime.includes(value))) return runtime;
    throw new Error("ZCode runtime has a partial runtime route patch.");
  }

  const ident = "([A-Za-z_$][\\w$]*)";
  const matchOnce = (name: string, pattern: RegExp): RegExpExecArray => {
    const match = pattern.exec(runtime);
    if (!match) {
      throw new Error(`ZCode runtime is incompatible with the runtime route patch (${name} anchor count 0).`);
    }
    return match;
  };

  const configKeys = matchOnce(
    "config keys",
    new RegExp(`${ident}=\\{ModelMain:"model.main",ModelLite:"model.lite",ModelAvailable:`, "u")
  );
  const configKeysVar = configKeys[1]!;
  const parseModel = matchOnce(
    "model ref parser",
    /function ([A-Za-z_$][\w$]*)\(e\)\{if\(typeof e=="string"\)try\{let t=([A-Za-z_$][\w$]*)\(e\);return\{provider:t.providerId,model:t.modelId\}/u
  );
  const parseModelRef = parseModel[2]!;
  const catalogLevels = matchOnce(
    "catalog thought levels",
    /strictPreferredThoughtLevel&&i&&!([A-Za-z_$][\w$]*)\(t,r\)\.includes\(i\)/u
  );
  const catalogLevelsFn = catalogLevels[1]!;
  const bootstrap = matchOnce(
    "main and lite selection",
    new RegExp(
      `_=n.bootstrapModelConfig\\?\\?\\(n.modelAdapter\\?r.config.model:${ident}\\(r\\)\\),`
      + `y=n.runtimeConfig\\?\\.modelRef\\?\\?\\(_\\?${ident}\\(_\\):void 0\\),`
      + `v=n.runtimeConfig\\?\\.modelProviderOptions,`
      + `x=v\\?${ident}\\(y,v,r.config.modelCatalog\\):${ident}\\(_,y,r.config.modelCatalog,i\\),`
      + `w=_\\?\\.lite\\?${ident}\\(_\\):void 0,`
      + `b=n.runtimeConfig\\?\\.liteModelRef\\?\\?w,`
      + `k=n.runtimeConfig\\?\\.liteModelProviderOptions\\?\\?\\(b\\?\\4\\(_,b,r.config.modelCatalog\\):void 0\\),S=`,
      "u"
    )
  );
  const readConfigModel = bootstrap[1]!;
  const toModelRef = bootstrap[2]!;
  const overlayProviderOptions = bootstrap[3]!;
  const resolveProviderOptions = bootstrap[4]!;
  const toLiteModelRef = bootstrap[5]!;
  const runtimeConfigAssign = matchOnce(
    "resolved main model",
    /let ([A-Za-z_$][\w$]*)=\{\.\.\.n.runtimeConfig,bashTimeoutPolicy:/u
  );
  const persistFn = matchOnce(
    "strict persistence availability",
    /async function ([A-Za-z_$][\w$]*)\(e,t\)\{if\(!e.sessionStore.saveSessionEntry\)return;/u
  );
  const persistFnName = persistFn[1]!;
  const persistFail = matchOnce(
    "strict persistence failure",
    /status:"failed",thoughtLevel:t\}\)\}\}function ([A-Za-z_$][\w$]*)/u
  );
  const sessionPersist = matchOnce(
    "session route persistence",
    /await ([A-Za-z_$][\w$]*)\(this,t\),this.sessionPersisted=!0,this.logger\?\.debug\("Session persisted"/u
  );
  const restoreCall = matchOnce(
    "restore policy input",
    /l&&\(u.model=l.model,u.thoughtLevel=l.thoughtLevel,u.thoughtSource="session_entry"\);let c=await ([A-Za-z_$][\w$]*)\(e,\{\.\.\.t,mode:u.mode,model:([A-Za-z_$][\w$]*)\(t.runtimeModel,u.model\),\.\.\.o.parentID\?\{parentSessionId:String\(o.parentID\)\}:\{\},workspace:i\}/u
  );
  const restoredAvailability = matchOnce(
    "restored policy availability",
    /([A-Za-z_$][\w$]*)=t.taskType\?\?"interactive",_=n&&!p&&!([A-Za-z_$][\w$]*)\(e,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(t.mcpServers\);/u
  );
  const agentOptions = matchOnce(
    "Agent route selection",
    /([A-Za-z_$][\w$]*)=l\?l.modelProviderOptions:c\?void 0:([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\(e,i,t.profile\):u\?this.config.liteModelProviderOptions\?\?this.config.modelProviderOptions:this.config.modelProviderOptions,_=([A-Za-z_$][\w$]*)\(this,p\)/u
  );
  const subagentRole = matchOnce(
    "Agent subagent role",
    /modelRef:\{\.\.\.l.modelRef,role:([A-Za-z_$][\w$]*)\.Subagent\}/u
  );
  const childCtor = matchOnce(
    "Agent child policy",
    /let ([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\(t.sessionId,\{mode:([A-Za-z_$][\w$]*),modelRef:p,/u
  );
  const childPersist = matchOnce(
    "Agent child persistence",
    /([A-Za-z_$][\w$]*)\?await ([A-Za-z_$][\w$]*)\.resumeFromStore\(\{traceContext:t.traceContext\}\):await \2.ensureSessionPersistedForExternalActivity\(t.prompt,\{traceContext:t.traceContext\}\),await ([A-Za-z_$][\w$]*)\(\),/u
  );
  const thoughtReader = matchOnce(
    "persisted policy reader",
    /let l=typeof i.thoughtLevel=="string"\?i.thoughtLevel.trim\(\):"";return\{model:\{modelId:([A-Za-z_$][\w$]*),providerId:([A-Za-z_$][\w$]*),\.\.\.l\?\{variant:l\}:\{\}\},\.\.\.l\?\{thoughtLevel:l\}:\{\}\}/u
  );
  const schema = matchOnce(
    "model schema",
    /=([A-Za-z_$][\w$]*)\.object\(\{main:([A-Za-z_$][\w$]*)\.optional\(\),lite:\2\.optional\(\)\}\)\.strict\(\)/u
  );

  let patched = runtime;
  const replaceOnce = (name: string, anchor: string, replacement: string) => {
    const count = patched.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(`ZCode runtime is incompatible with the runtime route patch (${name} anchor count ${count}).`);
    }
    patched = patched.split(anchor).join(replacement);
  };

  replaceOnce(
    "config keys",
    configKeys[0]!,
    `${configKeysVar}={ModelMain:"model.main",ModelLite:"model.lite",ModelMainThoughtLevel:"model.mainThoughtLevel",ModelLiteThoughtLevel:"model.liteThoughtLevel",ModelAvailable:`
  );
  replaceOnce(
    "config merge",
    `t.model&&(t.model.main&&this.set(${configKeysVar}.ModelMain,t.model.main,r),t.model.lite&&this.set(${configKeysVar}.ModelLite,t.model.lite,r),t.model.available&&this.set(${configKeysVar}.ModelAvailable,t.model.available,r))`,
    `t.model&&(t.model.main&&this.set(${configKeysVar}.ModelMain,t.model.main,r),t.model.lite&&this.set(${configKeysVar}.ModelLite,t.model.lite,r),t.model.mainThoughtLevel!==void 0&&this.set(${configKeysVar}.ModelMainThoughtLevel,t.model.mainThoughtLevel,r),t.model.liteThoughtLevel!==void 0&&this.set(${configKeysVar}.ModelLiteThoughtLevel,t.model.liteThoughtLevel,r),t.model.available&&this.set(${configKeysVar}.ModelAvailable,t.model.available,r))`
  );
  replaceOnce(
    "config projection",
    "model:t?{main:t,lite:r,available:n}:void 0,modelCatalog:",
    `model:t?{main:t,lite:r,available:n,...this.store.get(${configKeysVar}.ModelMainThoughtLevel)!==void 0?{mainThoughtLevel:this.store.get(${configKeysVar}.ModelMainThoughtLevel)}:{},...this.store.get(${configKeysVar}.ModelLiteThoughtLevel)!==void 0?{liteThoughtLevel:this.store.get(${configKeysVar}.ModelLiteThoughtLevel)}:{}}:void 0,modelCatalog:`
  );
  replaceOnce(
    "model schema",
    schema[0]!,
    `=${schema[1]}.object({main:${schema[2]}.optional(),lite:${schema[2]}.optional(),mainThoughtLevel:${schema[1]}.string().min(1).optional(),liteThoughtLevel:${schema[1]}.string().min(1).optional()}).strict()`
  );
  replaceOnce(
    "model parser",
    "return t&&(n.main=t),r&&(n.lite=r),Object.keys(n).length>0?n:void 0}",
    "return t&&(n.main=t),r&&(n.lite=r),typeof e.mainThoughtLevel===\"string\"&&(n.mainThoughtLevel=e.mainThoughtLevel),typeof e.liteThoughtLevel===\"string\"&&(n.liteThoughtLevel=e.liteThoughtLevel),Object.keys(n).length>0?n:void 0}"
  );
  replaceOnce(
    "model normalization",
    "return r&&(i.main=r),n&&(i.lite=n),o.length>0&&(i.available=o),Object.keys(i).length>0?i:void 0}",
    "return r&&(i.main=r),n&&(i.lite=n),t.mainThoughtLevel&&(i.mainThoughtLevel=t.mainThoughtLevel),t.liteThoughtLevel&&(i.liteThoughtLevel=t.liteThoughtLevel),o.length>0&&(i.available=o),Object.keys(i).length>0?i:void 0}"
  );

  const helpers = [
    `function __zcodeParseRoleModel(e){if(typeof e!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:+\\/-]{0,255}$/.test(e)||!e.includes("/"))return;try{return ${parseModelRef}(e)}catch{return}}`,
    "function __zcodeNormalizeRolePolicy(e){if(!e||typeof e!==\"object\"||Array.isArray(e))return;let t=[\"advisorModel\",\"advisorEffort\",\"gruntModel\",\"gruntEffort\"];if(!t.every(r=>typeof e[r]===\"string\"&&e[r].trim()))return;let r={advisorModel:e.advisorModel.trim(),advisorEffort:e.advisorEffort.trim(),gruntModel:e.gruntModel.trim(),gruntEffort:e.gruntEffort.trim()};if(!__zcodeParseRoleModel(r.advisorModel)||!__zcodeParseRoleModel(r.gruntModel)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(r.advisorEffort)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(r.gruntEffort))return;return Object.freeze(r)}",
    "function __zcodeResolveAdvisorRolePolicy(e){if(e?.enabled===!1)return;let t=e?.enabledPlugins??{},r=Object.keys(t).filter(n=>(n===\"sol-advisor\"||n.startsWith(\"sol-advisor@\"))&&t[n]===!0);if(r.length!==1||r[0]!==\"sol-advisor@sol-advisor\")return;let n=e?.options?.[r[0]];return __zcodeNormalizeRolePolicy(n&&typeof n===\"object\"&&!Array.isArray(n)?{advisorModel:n.advisor_model,advisorEffort:n.advisor_effort,gruntModel:n.grunt_model,gruntEffort:n.grunt_effort}:void 0)}",
    `function __zcodeSelectRuntimeRole(e,t,r,n,o){let i=t==="lite"?n?.gruntModel:n?.advisorModel,a=t==="lite"?n?.gruntEffort:n?.advisorEffort,u=i?__zcodeParseRoleModel(i):void 0,l=u?{...e,providerId:u.providerId,modelId:u.modelId}:e,c=a??(t==="lite"?r?.liteThoughtLevel:r?.mainThoughtLevel);if(c!==void 0){if(!l||o&&!${catalogLevelsFn}(l,o).includes(c)){let d=new Error("ZCODE_RUNTIME_ROUTE_UNSUPPORTED_THOUGHT_LEVEL");throw d.code="ZCODE_RUNTIME_ROUTE_UNSUPPORTED_THOUGHT_LEVEL",d}l={...l,variant:c}}return{modelRef:l,thoughtLevel:c}}`
  ].join("");
  replaceOnce(
    "runtime helpers",
    `function ${readConfigModel}(e){if(e.config.model)return e.config.model;`,
    `${helpers}function ${readConfigModel}(e){if(e.config.model)return e.config.model;`
  );

  replaceOnce(
    "main and lite selection",
    bootstrap[0]!,
    `_=n.bootstrapModelConfig??(n.modelAdapter?r.config.model:${readConfigModel}(r));let __zcodePolicy=n.runtimeConfig?.__zcodeRolePolicy??(n.runtimeConfig?.__zcodeDisableAdvisorOverlay||n.env?.ZCODE_RUNTIME_ROUTE_OVERRIDE==="1"?void 0:__zcodeResolveAdvisorRolePolicy(r.config.plugins)),y=n.runtimeConfig?.modelRef??(_?${toModelRef}(_):void 0),__zcodeMain=__zcodeSelectRuntimeRole(y,n.runtimeConfig?.__zcodeRouteRole==="lite"?"lite":"main",!__zcodePolicy&&n.runtimeConfig?.modelRef?void 0:_,__zcodePolicy,r.config.modelCatalog),v=__zcodePolicy?void 0:n.runtimeConfig?.modelProviderOptions,x=v?${overlayProviderOptions}(__zcodeMain.modelRef,v,r.config.modelCatalog):${resolveProviderOptions}(_,__zcodeMain.modelRef,r.config.modelCatalog,__zcodeMain.thoughtLevel??i,{strictPreferredThoughtLevel:__zcodeMain.thoughtLevel!==void 0}),w=_?.lite?${toLiteModelRef}(_):void 0,__zcodeLite=__zcodeSelectRuntimeRole(n.runtimeConfig?.liteModelRef??w,"lite",_,__zcodePolicy,r.config.modelCatalog),b=__zcodeLite.modelRef,k=__zcodePolicy?b?${resolveProviderOptions}(_,b,r.config.modelCatalog,__zcodeLite.thoughtLevel,{strictPreferredThoughtLevel:!0}):void 0:n.runtimeConfig?.liteModelProviderOptions??(b?${resolveProviderOptions}(_,b,r.config.modelCatalog,__zcodeLite.thoughtLevel,{strictPreferredThoughtLevel:__zcodeLite.thoughtLevel!==void 0}):void 0),S=`
  );
  replaceOnce(
    "resolved main model",
    runtimeConfigAssign[0]!,
    `y=__zcodeMain.modelRef;let ${runtimeConfigAssign[1]!}={...n.runtimeConfig,...__zcodePolicy?{__zcodeRolePolicy:__zcodePolicy,__zcodeRouteRole:n.runtimeConfig?.__zcodeRouteRole??"main",__zcodeRoutePolicySource:n.runtimeConfig?.__zcodeRoutePolicySource==="persisted"?"persisted":n.runtimeConfig?.__zcodeRoutePolicySource==="parent"?"parent":"new",__zcodeRoutePersisted:n.runtimeConfig?.__zcodeRoutePolicySource==="persisted"||n.runtimeConfig?.__zcodeRoutePolicySource==="parent"}:{},bashTimeoutPolicy:`
  );
  replaceOnce(
    "strict persistence availability",
    persistFn[0]!,
    `async function ${persistFnName}(e,t){if(!e.sessionStore?.saveSessionEntry){if(e.runtime.config?.__zcodeRolePolicy)throw new Error("ZCODE_RUNTIME_ROUTE_PERSISTENCE_UNAVAILABLE");return}`
  );
  replaceOnce(
    "policy persistence payload",
    "data:{modelId:String(r.modelId),providerId:String(r.providerId),...t?{thoughtLevel:t}:{}}})",
    "data:{modelId:String(r.modelId),providerId:String(r.providerId),...t?{thoughtLevel:t}:{},...e.runtime.config?.__zcodeRolePolicy?{role:e.runtime.config.__zcodeRouteRole,policySource:e.runtime.config.__zcodeRoutePolicySource,rolePolicy:e.runtime.config.__zcodeRolePolicy}:{}}})"
  );
  replaceOnce(
    "persistence logging",
    '}catch(o){e.logger.warn("Session model selection persistence failed"',
    '}catch(o){e.logger?.warn("Session model selection persistence failed"'
  );
  replaceOnce(
    "strict persistence failure",
    persistFail[0]!,
    `status:"failed",thoughtLevel:t});if(e.runtime.config?.__zcodeRolePolicy)throw o}}function ${persistFail[1]!}`
  );
  replaceOnce(
    "session route persistence",
    sessionPersist[0]!,
    `await ${sessionPersist[1]!}(this,t),this.sessionPersisted=!0;let __zcodePersistPolicy=this.config.__zcodeRolePolicy;if(__zcodePersistPolicy&&!this.config.__zcodeRoutePersisted){let __zcodePersistEffort=this.config.__zcodeRouteRole==="lite"?__zcodePersistPolicy.gruntEffort:__zcodePersistPolicy.advisorEffort;await ${persistFnName}({runtime:this,sessionStore:this.sessionStore,sessionId:this.sessionId,logger:this.logger,traceContext:t},__zcodePersistEffort),this.config.__zcodeRoutePersisted=!0}this.logger?.debug("Session persisted"`
  );
  replaceOnce(
    "persisted policy reader",
    thoughtReader[0]!,
    `let l=typeof i.thoughtLevel=="string"?i.thoughtLevel.trim():"",c=__zcodeNormalizeRolePolicy(i.rolePolicy),d=i.role==="lite"?"lite":"main",p=i.policySource==="parent"||d==="lite"?"parent":"persisted";return{model:{modelId:${thoughtReader[1]!},providerId:${thoughtReader[2]!},...l?{variant:l}:{}},...l?{thoughtLevel:l}:{},...c?{rolePolicy:c,role:d,policySource:p}:{}}`
  );
  replaceOnce(
    "restore policy input",
    restoreCall[0]!,
    `l&&(u.model=l.model,u.thoughtLevel=l.thoughtLevel,u.thoughtSource="session_entry");let c=await ${restoreCall[1]!}(e,{...t,mode:u.mode,model:${restoreCall[2]!}(t.runtimeModel,u.model),...l?.rolePolicy?{__zcodeRolePolicy:l.rolePolicy,__zcodeRouteRole:l.role==="lite"||o.parentID?"lite":"main",__zcodeRoutePolicySource:l.policySource==="parent"||o.parentID?"parent":"persisted"}:{__zcodeDisableAdvisorOverlay:!0},...o.parentID?{parentSessionId:String(o.parentID)}:{},workspace:i}`
  );
  replaceOnce(
    "restore policy runtime config",
    'runtimeConfig:{mode:"mode"in t?t.mode:void 0,modelRef:',
    'runtimeConfig:{...t.__zcodeRolePolicy?{__zcodeRolePolicy:t.__zcodeRolePolicy,__zcodeRouteRole:t.__zcodeRouteRole??"main",__zcodeRoutePolicySource:t.__zcodeRoutePolicySource??"persisted"}:{},...t.__zcodeDisableAdvisorOverlay?{__zcodeDisableAdvisorOverlay:!0}:{},mode:"mode"in t?t.mode:void 0,modelRef:'
  );
  replaceOnce(
    "restored policy availability",
    restoredAvailability[0]!,
    `${restoredAvailability[1]!}=t.taskType??"interactive",_=n&&!p&&!t.__zcodeRolePolicy&&!${restoredAvailability[2]!}(e,${restoredAvailability[3]!},${restoredAvailability[4]!}),${restoredAvailability[5]!}=${restoredAvailability[6]!}(t.mcpServers);`
  );
  replaceOnce(
    "Agent route selection",
    agentOptions[0]!,
    `${agentOptions[1]!}=l?l.modelProviderOptions:c?void 0:${agentOptions[2]!}?${agentOptions[3]!}(e,i,t.profile):u?this.config.liteModelProviderOptions??this.config.modelProviderOptions:this.config.modelProviderOptions;let __zcodeRolePolicy=this.config.__zcodeRolePolicy;if(__zcodeRolePolicy){let __zcodeChild=__zcodeSelectRuntimeRole(this.config.liteModelRef??i,"lite",void 0,__zcodeRolePolicy);l=void 0,c=void 0,d=void 0,p={...__zcodeChild.modelRef,role:${subagentRole[1]!}.Subagent},m=e.resolveRuntimeModelLimits?.(p),${agentOptions[1]!}=e.resolveModelProviderOptions?.(p,__zcodeChild.thoughtLevel)}let _=${agentOptions[4]!}(this,p)`
  );
  replaceOnce(
    "Agent child policy",
    childCtor[0]!,
    `let ${childCtor[1]!}=new ${childCtor[2]!}(t.sessionId,{...__zcodeRolePolicy?{__zcodeRolePolicy:__zcodeRolePolicy,__zcodeRouteRole:"lite",__zcodeRoutePolicySource:"parent"}:{},hooks:this.config.hooks,mode:${childCtor[3]!},modelRef:p,`
  );
  replaceOnce(
    "Agent child persistence",
    childPersist[0]!,
    `${childPersist[1]!}?await ${childPersist[2]!}.resumeFromStore({traceContext:t.traceContext}):await ${childPersist[2]!}.ensureSessionPersistedForExternalActivity(t.prompt,{traceContext:t.traceContext}),${childPersist[2]!}.config.__zcodeRolePolicy&&!${childPersist[2]!}.config.__zcodeRoutePersisted&&(await ${persistFnName}({runtime:${childPersist[2]!},sessionStore:e.sessionStore,sessionId:t.sessionId,logger:this.logger,traceContext:t.traceContext},${childPersist[2]!}.config.__zcodeRolePolicy.gruntEffort),${childPersist[2]!}.config.__zcodeRoutePersisted=!0),await ${childPersist[3]!}(),`
  );
  return patched;
}

/** Add runtime-owned evidence to every native lifecycle hook payload. */
export function patchRuntimeAttestation(runtime: string): string {
  const marker = "function __zcodeRuntimeAttestation";
  const requiredMarkers = [
    marker,
    'type:"zcode_runtime_attestation"',
    'route:"native"',
    "rolePolicyFingerprint",
    "runtimeAttestation:__zcodeRuntimeAttestation",
    "childRuntimeEvidence",
    "__zcodeChildRuntimeEvidence",
    "__zcodeDefineHidden",
    "getRuntimeRouteConfig",
    "function __zcodeWriteOdwAttestation",
    "__zcodeRuntimeApp",
    "ZCODE_ODW_RUNTIME_ATTESTATION"
  ];
  if (runtime.includes(marker)) {
    if (requiredMarkers.every((value) => runtime.includes(value))) return runtime;
    throw new Error("ZCode runtime has a partial runtime attestation patch.");
  }

  const matchOnce = (name: string, pattern: RegExp): RegExpExecArray => {
    const match = pattern.exec(runtime);
    if (!match) {
      throw new Error(`ZCode runtime is incompatible with the runtime attestation patch (${name} anchor count 0).`);
    }
    return match;
  };

  const modelRefInput = matchOnce(
    "tool executor route config input",
    /getModelRef:([A-Za-z_$][\w$]*)\(\(\)=>e.defaultModelRef,"getModelRef"\),skillPort:/u
  );
  const childTurn = matchOnce(
    "child runtime completion attestation",
    /try\{return await ([A-Za-z_$][\w$]*)\.executeTurn\(t.prompt,void 0,\{abortSignal:r\?\.signal,\.\.\.d\?\{turnExecutionModel:d\}:\{\},inputSource:"subagent",traceContext:t.traceContext\}\)\}finally\{let ([A-Za-z_$][\w$]*)=r\?\.signal\?\.aborted===!0;/u
  );
  const sessionStart = matchOnce(
    "SessionStart",
    /hookEventName:([A-Za-z_$][\w$]*)\.SessionStart,mode:this.getMode\(\),model:([A-Za-z_$][\w$]*)\(this.defaultModelRef\),sessionId:this.sessionId,source:e,/u
  );
  const preToolUse = matchOnce(
    "PreToolUse",
    /hookEventName:([A-Za-z_$][\w$]*)\.PreToolUse,mode:o,riskLevel:n.metadata.riskLevel,sessionId:e.sessionId,sideEffectScope:n.metadata.sideEffectScope,/u
  );
  const postToolUse = matchOnce(
    "PostToolUse",
    /hookEventName:([A-Za-z_$][\w$]*)\.PostToolUse,mode:e.getMode\(\),sessionId:e.sessionId,timestamp:new Date\(\).toISOString\(\),toolCallId:t.id,/u
  );
  const postToolUseFailure = matchOnce(
    "PostToolUseFailure",
    /hookEventName:([A-Za-z_$][\w$]*)\.PostToolUseFailure,isInterrupt:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)&&\3\.type===([A-Za-z_$][\w$]*)\.ToolCancelled,mode:e.getMode\(\),sessionId:e.sessionId,timestamp:new Date\(\).toISOString\(\),toolCallId:t.id,/u
  );
  const odwBootstrap = matchOnce(
    "ODW app capture declaration",
    /try\{let I=o.env\?\?process.env,([A-Za-z_$][\w$]*)=\(o.cwd\?\?process.cwd\)\(\),([A-Za-z_$][\w$]*)=\(o.loadDotenv\?\?([A-Za-z_$][\w$]*)\)\(\{cwd:\1,env:I\}\);/u
  );
  const odwCatch = matchOnce(
    "ODW provider failure footer",
    /\}catch\(I\)\{let ([A-Za-z_$][\w$]*)=I instanceof Error\?I.message:String\(I\);/u
  );
  const helperHost = matchOnce(
    "runtime helpers host",
    /function ([A-Za-z_$][\w$]*)\(e\)\{if\(e.config.model\)return e.config.model;/u
  );

  const helper = [
    'function __zcodeDefineHidden(e,t,r){if(!e||typeof e!=="object")return e;Object.defineProperty(e,t,{value:r,enumerable:!1,configurable:!0});return e}',
    'function __zcodeRuntimeAttestation(e){let t=e.getModelRef(),c=e.config??e.getRuntimeRouteConfig?.(),r=c?.__zcodeRolePolicy??null,n=c?.__zcodeRouteRole==="lite"?"lite":"main",o=n==="lite"?(c?.parentSessionId??null):null,i=r?c?.__zcodeRoutePolicySource??"new":null,a=r?require("node:crypto").createHash("sha256").update(JSON.stringify({advisorModel:r.advisorModel,advisorEffort:r.advisorEffort,gruntModel:r.gruntModel,gruntEffort:r.gruntEffort})).digest("hex"):null;return{type:"zcode_runtime_attestation",schemaVersion:1,executor:"zcode",route:"native",runtimeId:String(e.sessionId),runtimeVersion:String(process.env.ZCODE_RUNTIME_VERSION??"unknown"),sessionId:String(e.sessionId),role:n,parentSessionId:o,policySource:i,rolePolicy:r,rolePolicyFingerprint:a,model:`${String(t.providerId)}/${String(t.modelId)}`,reasoningEffort:String(t.variant??"")}}',
    'function __zcodeWriteOdwAttestation(e,t){if(process.env.ZCODE_ODW_PROTOCOL!=="1"||!t?.runtime)return;let r=t.runtime.getModelRef?.();if(!r)return;e.stderr.write(JSON.stringify({type:"zcode_runtime_attestation",schemaVersion:1,executor:"zcode",route:"odw",runtimeId:String(t.sessionId),runtimeVersion:String(process.env.ZCODE_RUNTIME_VERSION??"unknown"),sessionId:String(t.sessionId),role:"main",parentSessionId:null,policySource:null,rolePolicy:null,rolePolicyFingerprint:null,model:String(r.providerId)+"/"+String(r.modelId),reasoningEffort:String(r.variant??"")})+"\\n")}'
  ].join("");

  let patched = runtime;
  const replaceOnce = (name: string, anchor: string, replacement: string) => {
    const count = patched.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(`ZCode runtime is incompatible with the runtime attestation patch (${name} anchor count ${count}).`);
    }
    patched = patched.split(anchor).join(replacement);
  };

  replaceOnce(
    "tool executor route config input",
    modelRefInput[0]!,
    `getModelRef:${modelRefInput[1]!}(()=>e.defaultModelRef,"getModelRef"),getRuntimeRouteConfig:${modelRefInput[1]!}(()=>e.config,"getRuntimeRouteConfig"),skillPort:`
  );
  replaceOnce(
    "tool executor route config storage",
    "getModelRef:t.getModelRef,skillPort:",
    "getModelRef:t.getModelRef,getRuntimeRouteConfig:t.getRuntimeRouteConfig,skillPort:"
  );
  replaceOnce(
    "child runtime completion attestation",
    childTurn[0]!,
    `try{let __zcodeChildTurnResult=await ${childTurn[1]!}.executeTurn(t.prompt,void 0,{abortSignal:r?.signal,...d?{turnExecutionModel:d}:{},inputSource:"subagent",traceContext:t.traceContext});return __zcodeDefineHidden(__zcodeChildTurnResult,"__zcodeRuntimeAttestation",__zcodeRuntimeAttestation(${childTurn[1]!}))}finally{let ${childTurn[2]!}=r?.signal?.aborted===!0;`
  );
  replaceOnce(
    "foreground Agent child evidence",
    "return{events:c.events,output:_}",
    'if(c.__zcodeRuntimeAttestation?.role==="lite"&&c.__zcodeRuntimeAttestation.parentSessionId===String(t.sessionId))__zcodeDefineHidden(_,"__zcodeChildRuntimeEvidence",{childSessionId:String(r.childSessionId),parentSessionId:String(t.sessionId),parentToolCallId:String(t.parentToolCallId),state:"completed",runtimeAttestation:c.__zcodeRuntimeAttestation});return{events:c.events,output:_}'
  );
  replaceOnce(
    "SessionStart",
    sessionStart[0]!,
    `hookEventName:${sessionStart[1]!}.SessionStart,mode:this.getMode(),model:${sessionStart[2]!}(this.defaultModelRef),sessionId:this.sessionId,runtimeAttestation:__zcodeRuntimeAttestation(this),source:e,`
  );
  replaceOnce(
    "PreToolUse",
    preToolUse[0]!,
    `hookEventName:${preToolUse[1]!}.PreToolUse,mode:o,riskLevel:n.metadata.riskLevel,sessionId:e.sessionId,runtimeAttestation:__zcodeRuntimeAttestation(e),sideEffectScope:n.metadata.sideEffectScope,`
  );
  replaceOnce(
    "PostToolUse",
    postToolUse[0]!,
    `hookEventName:${postToolUse[1]!}.PostToolUse,mode:e.getMode(),sessionId:e.sessionId,runtimeAttestation:__zcodeRuntimeAttestation(e),childRuntimeEvidence:t.name==="Agent"?(n?.__zcodeChildRuntimeEvidence??null):void 0,timestamp:new Date().toISOString(),toolCallId:t.id,`
  );
  replaceOnce(
    "PostToolUseFailure",
    postToolUseFailure[0]!,
    `hookEventName:${postToolUseFailure[1]!}.PostToolUseFailure,isInterrupt:${postToolUseFailure[2]!}(${postToolUseFailure[3]!})&&${postToolUseFailure[3]!}.type===${postToolUseFailure[4]!}.ToolCancelled,mode:e.getMode(),sessionId:e.sessionId,runtimeAttestation:__zcodeRuntimeAttestation(e),timestamp:new Date().toISOString(),toolCallId:t.id,`
  );
  replaceOnce(
    "ODW app capture declaration",
    odwBootstrap[0]!,
    `let __zcodeRuntimeApp;try{let I=o.env??process.env,${odwBootstrap[1]!}=(o.cwd??process.cwd)(),${odwBootstrap[2]!}=(o.loadDotenv??${odwBootstrap[3]!})({cwd:${odwBootstrap[1]!},env:I});`
  );
  replaceOnce(
    "ODW app capture",
    "_=P({browserControlPort:",
    "__zcodeRuntimeApp=_=P({browserControlPort:"
  );
  replaceOnce(
    "ODW provider failure footer",
    odwCatch[0]!,
    `}catch(I){__zcodeWriteOdwAttestation(e,__zcodeRuntimeApp);let ${odwCatch[1]!}=I instanceof Error?I.message:String(I);`
  );
  replaceOnce(
    "runtime helpers host",
    helperHost[0]!,
    `${helper}${helperHost[0]!}`
  );

  const usagePrefix = /\(process\.env\.ZCODE_ODW_PROTOCOL==="1"&&([A-Za-z_$][\w$]*)\.stderr\.write\(JSON\.stringify\(\{type:"zcode_usage",sessionId:([A-Za-z_$][\w$]*)\.sessionId,/gu;
  const usageMatches = [...patched.matchAll(usagePrefix)];
  if (usageMatches.length < 2) {
    throw new Error(`ZCode runtime is incompatible with the runtime attestation patch (ODW footer anchor count ${usageMatches.length}).`);
  }
  patched = patched.replace(usagePrefix, (_match, streamsVar: string, appVar: string) => (
    `(/*ZCODE_ODW_RUNTIME_ATTESTATION*/process.env.ZCODE_ODW_PROTOCOL==="1"&&${streamsVar}.stderr.write(JSON.stringify({type:"zcode_runtime_attestation",schemaVersion:1,executor:"zcode",route:"odw",runtimeId:String(${appVar}.sessionId),runtimeVersion:String(process.env.ZCODE_RUNTIME_VERSION??"unknown"),sessionId:String(${appVar}.sessionId),role:"main",parentSessionId:null,policySource:null,rolePolicy:null,rolePolicyFingerprint:null,model:String(${appVar}.runtime.getModelRef().providerId)+"/"+String(${appVar}.runtime.getModelRef().modelId),reasoningEffort:String(${appVar}.runtime.getModelRef().variant??"")})+"\\n"),process.env.ZCODE_ODW_PROTOCOL==="1"&&${streamsVar}.stderr.write(JSON.stringify({type:"zcode_usage",sessionId:${appVar}.sessionId,`
  ));
  return patched;
}

/**
 * Minified helper injected into the official runtime.
 * 3.10.2 wraps SessionStart failures as `Turn execution failed` with the original
 * error on `.cause`; protocol retries must surface the nested marker in RPC JSON.
 * Protocol `sendInput` also returns `{completion}` instead of rejecting, so ZDi
 * must await that promise before the catch can record `restoreWarning`.
 */
export const STRICT_ADVISOR_HOOK_FAILURE_MESSAGE_HELPER = "function __zcodeStrictAdvisorHookFailureMessage(e){for(let t=e,r=0;t&&r<8;t=t.cause,r++){let n=String(t?.message??t);if(n.includes(\"ZCODE_STRICT_ADVISOR_HOOK_FAILURE\"))return n}}";

/** Make only the exact Advisor plugin hook source fail closed on lifecycle errors. */
export function patchRuntimeStrictAdvisorHooks(runtime: string): string {
  const marker = "function __zcodeIsStrictAdvisorHook";
  const requiredMarkers = [
    marker,
    "function __zcodeStrictAdvisorHookFailureMessage",
    "ZCODE_STRICT_ADVISOR_HOOK_FAILURE",
    "ZCODE_SESSION_START_HOOK_STATE",
    "let _zcodeSendResult=await t.app.sendInput({attachments:"
  ];
  if (runtime.includes(marker)) {
    if (requiredMarkers.every((value) => runtime.includes(value))) return runtime;
    throw new Error("ZCode runtime has a partial strict Advisor hook patch.");
  }

  const matchOnce = (name: string, pattern: RegExp): RegExpExecArray => {
    const match = pattern.exec(runtime);
    if (!match) {
      throw new Error(`ZCode runtime is incompatible with the strict Advisor hook patch (${name} anchor count 0).`);
    }
    return match;
  };

  const foregroundEmpty = matchOnce(
    "foreground empty output",
    /let v=await this.runCallbackWithTimeout\(d,t,c,r.signal\),x=Date.now\(\)-_,w=([A-Za-z_$][\w$]*)\(t.hookEventName,v\);/u
  );
  const foregroundFail = matchOnce(
    "foreground failure",
    /\}catch\(v\)\{let x=Date.now\(\)-_,w=([A-Za-z_$][\w$]*)\(v\),b=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\(v\)\);/u
  );
  const backgroundEmpty = matchOnce(
    "background empty output",
    /await this.runCallbackWithTimeout\(o,l,d,c\),await this.emitHookEvent/u
  );
  const backgroundFail = matchOnce(
    "background failure",
    /\}catch\(m\)\{let ([A-Za-z_$][\w$]*)=Date.now\(\)-p,_=([A-Za-z_$][\w$]*)\(m\),y=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\(m\)\);/u
  );
  const protocolFail = matchOnce(
    "protocol strict failure state",
    /catch\(c\)\{o="prompt_failed",e.logger\?\.warn\("ZCode Protocol background turn failed",/u
  );
  const protocolSend = matchOnce(
    "protocol send completion",
    /try\{await t\.app\.sendInput\(\{attachments:/u
  );
  const protocolCompleted = matchOnce(
    "protocol turn completed log",
    /:\{\}\}\),e\.logger\?\.info\("ZCode Protocol background turn completed"/u
  );
  const sessionStart = matchOnce(
    "session-start reuse",
    /async function ([A-Za-z_$][\w$]*)\(e,t,r\)\{return this.sessionStartHookRan\|\|\(await this.workspaceHookAdmission\?\.activate\(e,r\),this.sessionStartHookRan=!0,!this.hookRunner\)\?([A-Za-z_$][\w$]*):this.hookRunner.run\(/u
  );
  const helperHost = matchOnce(
    "runtime helpers host",
    /function ([A-Za-z_$][\w$]*)\(e\)\{if\(e.config.model\)return e.config.model;/u
  );

  let patched = runtime;
  const replaceOnce = (name: string, anchor: string, replacement: string) => {
    const count = patched.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(`ZCode runtime is incompatible with the strict Advisor hook patch (${name} anchor count ${count}).`);
    }
    patched = patched.split(anchor).join(replacement);
  };

  replaceOnce(
    "strict hook helper",
    helperHost[0]!,
    `${STRICT_ADVISOR_HOOK_FAILURE_MESSAGE_HELPER}function __zcodeIsStrictAdvisorHook(e){return typeof e?.source==="string"&&e.source.startsWith("plugin.sol-advisor@sol-advisor.")}${helperHost[0]!}`
  );
  replaceOnce(
    "foreground empty output",
    "let v=await this.runCallbackWithTimeout(d,t,c,r.signal),x=Date.now()-_,",
    'let v=await this.runCallbackWithTimeout(d,t,c,r.signal);if(__zcodeIsStrictAdvisorHook(d)&&v===void 0)throw new Error("ZCODE_STRICT_ADVISOR_HOOK_FAILURE: empty output");let x=Date.now()-_,'
  );
  replaceOnce(
    "foreground failure",
    foregroundFail[0]!,
    `}catch(v){if(__zcodeIsStrictAdvisorHook(d))throw new Error("ZCODE_STRICT_ADVISOR_HOOK_FAILURE: "+${foregroundFail[3]!}(v),{cause:v});let x=Date.now()-_,w=${foregroundFail[1]!}(v),b=${foregroundFail[2]!}(${foregroundFail[3]!}(v));`
  );
  replaceOnce(
    "background empty output",
    backgroundEmpty[0]!,
    'let result=await this.runCallbackWithTimeout(o,l,d,c);if(__zcodeIsStrictAdvisorHook(o)&&result===void 0)throw new Error("ZCODE_STRICT_ADVISOR_HOOK_FAILURE: empty output");await this.emitHookEvent'
  );
  replaceOnce(
    "background failure",
    backgroundFail[0]!,
    `}catch(m){if(__zcodeIsStrictAdvisorHook(o))throw new Error("ZCODE_STRICT_ADVISOR_HOOK_FAILURE: "+${backgroundFail[4]!}(m),{cause:m});let ${backgroundFail[1]!}=Date.now()-p,_=${backgroundFail[2]!}(m),y=${backgroundFail[3]!}(${backgroundFail[4]!}(m));`
  );
  replaceOnce(
    "protocol strict failure state",
    protocolFail[0]!,
    'catch(c){let _zcodeStrictAdvisorHookFailure=__zcodeStrictAdvisorHookFailureMessage(c);if(_zcodeStrictAdvisorHookFailure)t.restoreWarning={type:"zcode_strict_advisor_hook_failure",message:_zcodeStrictAdvisorHookFailure};o="prompt_failed",e.logger?.warn("ZCode Protocol background turn failed",'
  );
  replaceOnce(
    "protocol send completion",
    protocolSend[0]!,
    "try{let _zcodeSendResult=await t.app.sendInput({attachments:"
  );
  replaceOnce(
    "protocol turn completed log",
    protocolCompleted[0]!,
    ":{}});let _zcodeSendDone=_zcodeSendResult?.completion??_zcodeSendResult?.result;if(_zcodeSendDone)await _zcodeSendDone;e.logger?.info(\"ZCode Protocol background turn completed\""
  );
  replaceOnce(
    "session-start reuse",
    sessionStart[0]!,
    `async function ${sessionStart[1]!}(e,t,r){return this.sessionStartHookRan?${sessionStart[2]!}:(await this.workspaceHookAdmission?.activate(e,r),/*ZCODE_SESSION_START_HOOK_STATE*/(!this.hookRunner?(this.sessionStartHookRan=!0,${sessionStart[2]!}):this.hookRunner.run(`
  );
  replaceOnce(
    "session-start hook success",
    "},{matchValue:e,signal:r})}",
    "},{matchValue:e,signal:r}).then((n=>{this.sessionStartHookRan=!0;return n}))))}"
  );
  return patched;
}

async function installTuiBridge(nextVendor: string): Promise<RuntimePatchReport[]> {
  const runtimePath = join(nextVendor, "zcode.cjs");
  const runtime = await readFile(runtimePath, "utf8");
  const result = applyRuntimePatchPlan(runtime);
  await writeFile(runtimePath, result.runtime);
  return result.reports;
}

async function findFile(directory: string, name: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const match = await findFile(path, name);
      if (match) return match;
    }
  }
  return null;
}

async function extractWith7Zip(
  archive: string,
  output: string,
  platform: SyncOptions["platform"]
): Promise<string> {
  const first = join(output, "stage-1");
  await mkdir(first, { recursive: true });
  await run("7z", ["x", archive, `-o${first}`, "-y"]);

  if (platform === "linux") {
    const compressedTar = await findFile(first, "data.tar.xz");
    if (!compressedTar) throw new Error("Linux package does not contain data.tar.xz.");
    const second = join(output, "stage-2");
    const third = join(output, "root");
    await mkdir(second, { recursive: true });
    await mkdir(third, { recursive: true });
    await run("7z", ["x", compressedTar, `-o${second}`, "-y"]);
    const tar = await findFile(second, "data.tar");
    if (!tar) throw new Error("Could not unpack data.tar.xz.");
    await run("7z", ["x", tar, `-o${third}`, "-y"]);
    return third;
  }

  if (platform === "win32") {
    const appArchive = await findFile(first, "app-64.7z");
    if (!appArchive) throw new Error("Windows installer does not contain app-64.7z.");
    const second = join(output, "root");
    await mkdir(second, { recursive: true });
    await run("7z", ["x", appArchive, `-o${second}`, "-y"]);
    return second;
  }

  return first;
}

async function getLocalAppVersion(app: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("--app version discovery currently requires macOS.");
  return run(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")],
    { capture: true }
  );
}

async function resolveLockedSource(lock: RuntimeLock, temporaryDirectory: string): Promise<RuntimeSource> {
  const archiveName = basename(new URL(lock.url).pathname) || "zcode-installer";
  const archive = join(temporaryDirectory, archiveName);
  console.log(`Downloading ${lock.url}`);
  await download(lock.url, archive);
  const actualHash = await sha512Base64(archive);
  if (actualHash !== lock.sha512) {
    throw new Error(
      `Downloaded installer failed SHA-512 verification.\n`
      + `  manifest/lock: ${lock.sha512}\n`
      + `  actual file:   ${actualHash}\n`
      + `The published manifest may carry stale checksum metadata. `
      + `If the downloaded installer is trusted, update zcode-runtime.lock.json with the actual sha512 above and re-run.`
    );
  }
  const extracted = await extractWith7Zip(archive, join(temporaryDirectory, "extract"), lock.platform);
  const runtime = await findFile(extracted, "zcode.cjs");
  if (!runtime || basename(dirname(runtime)) !== "glm") {
    throw new Error("Could not locate resources/glm/zcode.cjs.");
  }
  return {
    appVersion: lock.appVersion,
    glm: dirname(runtime),
    lock,
    source: lock.url
  };
}

async function resolveSource(options: SyncOptions, temporaryDirectory: string): Promise<RuntimeSource> {
  if (options.app) {
    const app = resolve(options.app);
    const glm = join(app, "Contents", "Resources", "glm");
    if (!existsSync(join(glm, "zcode.cjs"))) throw new Error(`No ZCode runtime found in ${app}`);
    return {
      appVersion: options.version ?? await getLocalAppVersion(app),
      glm,
      source: app
    };
  }

  if (options.lock) {
    const lockPath = resolve(root, options.lock);
    const lock = parseRuntimeLock(JSON.parse(await readFile(lockPath, "utf8")));
    return resolveLockedSource(lock, temporaryDirectory);
  }

  const resolved = await resolveLatestRuntimeLock(options);
  const candidate = resolved.lock;
  console.log(
    `Resolved stable ZCode App ${candidate.appVersion} from the ${resolved.source} manifest ${resolved.url}.`
  );
  const currentLockPath = join(root, "zcode-runtime.lock.json");
  const current = existsSync(currentLockPath)
    ? parseRuntimeLock(JSON.parse(await readFile(currentLockPath, "utf8")))
    : undefined;
  const lock = selectRuntimeLock(candidate, current);
  if (lock === current) {
    console.log(
      `Keeping locked runtime ${current.appVersion}; the ${options.platform}-${options.arch} manifest reports older ${candidate.appVersion}.`
    );
  }
  return resolveLockedSource(lock, temporaryDirectory);
}

async function sync(options: SyncOptions): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-sync-"));
  const nextVendor = join(root, ".vendor-next");
  const compatibilityJson = join(root, ".release", "runtime-compatibility.json");
  const compatibilityMarkdown = join(root, ".release", "runtime-compatibility.md");
  let source: RuntimeSource | undefined;
  let runtimePatches: RuntimePatchReport[] = [];
  await rm(compatibilityJson, { force: true });
  await rm(compatibilityMarkdown, { force: true });
  try {
    source = await resolveSource(options, temporaryDirectory);
    await rm(nextVendor, { recursive: true, force: true });
    await cp(source.glm, nextVendor, { recursive: true });
    runtimePatches = await installTuiBridge(nextVendor);
    await installLocalTui(nextVendor);
    const node = process.env.ZCODE_NODE || Bun.which("node");
    if (!node) throw new Error("Node.js >=22.19 is required to validate the official ZCode runtime.");
    const cliVersion = await run(node, [join(nextVendor, "zcode.cjs"), "--version"], { capture: true });
    const runtimeCapabilities = extractRuntimeCapabilities(
      await readFile(join(nextVendor, "zcode.cjs"), "utf8")
    );
    await writeFile(join(nextVendor, "extraction.json"), `${JSON.stringify({
      appVersion: source.appVersion,
      cliVersion,
      extractedAt: new Date().toISOString(),
      ...(source.lock ? { sha512: source.lock.sha512 } : {}),
      source: source.source,
      runtimeCapabilities,
      runtimePatches,
      tui: {
        implementation: "@zcode/tui",
        foundation: "@earendil-works/pi-tui"
      }
    }, null, 2)}\n`);

    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    // `--app` (local development sync) must not bump package.json or the CI
    // lock file: the local macOS App may be newer than the Linux release the CI
    // gate pins, and dev drift would break the "pins the exact remote runtime"
    // test. Only the manifest/lock sync paths (`sync`, `sync:locked`) own the
    // committed version + lock — matching the CI release workflow contract.
    if (options.app) {
      const currentVersion = String(packageJson.version ?? "");
      if (parseReleaseVersion(currentVersion)?.appVersion !== source.appVersion) {
        console.log(
          `Local App ${source.appVersion} differs from package.json ${currentVersion}; run \`bun run sync\` to align the CI lock.`
        );
      }
    } else {
      const packageVersion = syncedReleaseVersion(source.appVersion, String(packageJson.version ?? ""));
      packageJson.version = packageVersion;
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      if (source.lock) {
        await writeFile(join(root, "zcode-runtime.lock.json"), `${JSON.stringify(source.lock, null, 2)}\n`);
      }
    }
    await rm(join(root, "vendor"), { recursive: true, force: true });
    await rename(nextVendor, join(root, "vendor"));
    console.log(`Prepared ${String(packageJson.name)}@${packageJson.version} with ${cliVersion}.`);
  } catch (error) {
    const report: RuntimeCompatibilityFailure = {
      schemaVersion: 1,
      ...(source ? { appVersion: source.appVersion } : {}),
      generatedAt: new Date().toISOString(),
      phase: !source
        ? "runtime_discovery"
        : error instanceof RuntimePatchError ? "runtime_patch" : "runtime_sync",
      error: error instanceof Error ? error.message : String(error),
      runtimePatches: error instanceof RuntimePatchError ? error.reports : runtimePatches
    };
    await writeRuntimeCompatibilityFailure(report, dirname(compatibilityJson));
    throw error;
  } finally {
    await rm(nextVendor, { recursive: true, force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await sync(parseArgs(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
