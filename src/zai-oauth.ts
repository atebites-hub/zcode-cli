import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  createDarwinUrlCallbackReceiver,
  type DarwinUrlCallbackReceiver
} from "./darwin-oauth-callback.ts";
import { captureCommand } from "./command.ts";
import {
  createPortableOAuthCallbackReceiver,
  type CommandRunner,
  type OAuthCallbackReceiver
} from "./portable-oauth-callback.ts";

const authorizeEndpoint = "https://chat.z.ai/api/oauth/authorize";
const clientId = "client_P8X5CMWmlaRO9gyO-KSqtg";
const redirectUri = "zcode://zai-auth/callback";
const supportedLoginFlags = new Set(["--json", "--no-browser", "--oauth", "--verbose"]);

export interface ZaiOAuthInvocation {
  json: boolean;
  noBrowser: boolean;
  runtimeArgs: string[];
}

export interface ZaiOAuthCallback {
  callbackUrl: string;
  code: string;
  state: string;
}

export interface OfficialLoginPayload {
  callbackUrl: string;
  state: string;
}

interface BrowserOpenResult {
  opened: boolean;
  reason?: string;
}

interface WritableOutput {
  write(value: string): unknown;
}

export interface ZaiOAuthLoginOptions {
  abortSignal?: AbortSignal;
  completeLogin(payload: OfficialLoginPayload, runtimeArgs: string[]): Promise<number>;
  createReceiver?: (options: {
    env: NodeJS.ProcessEnv;
    scheme: string;
  }) => Promise<OAuthCallbackReceiver | DarwinUrlCallbackReceiver>;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream | null;
  invocation: ZaiOAuthInvocation;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  output?: WritableOutput;
  platform?: NodeJS.Platform;
  registerSchemeHandler?: boolean;
  runCommand?: CommandRunner;
  state?: string;
  timeoutMs?: number;
}

export function classifyZaiOAuthInvocation(args: string[]): ZaiOAuthInvocation | null {
  const positionals = args.filter((argument) => !argument.startsWith("-"));
  if (positionals.length !== 1 || positionals[0] !== "login") return null;
  if (args.some((argument) => argument.startsWith("-") && !supportedLoginFlags.has(argument))) {
    return null;
  }
  return {
    json: args.includes("--json"),
    noBrowser: args.includes("--no-browser"),
    runtimeArgs: args.filter((argument) => argument !== "--oauth")
  };
}

export function buildZaiAuthorizeUrl(state: string): string {
  const url = new URL(authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state
  }).toString();
  return url.toString();
}

export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string
): { args: string[]; command: string } {
  switch (platform) {
    case "darwin":
      return { args: [url], command: "/usr/bin/open" };
    case "win32":
      return { args: ["/c", "start", "", url], command: "cmd.exe" };
    case "aix":
    case "android":
    case "freebsd":
    case "haiku":
    case "linux":
    case "openbsd":
    case "sunos":
    case "cygwin":
    case "netbsd":
      return { args: [url], command: "xdg-open" };
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}

function statesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function safeAuthorizationError(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);
}

export function parseZaiOAuthCallback(callbackUrl: string, expectedState: string): ZaiOAuthCallback {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("Z.AI returned an invalid OAuth callback URL.");
  }
  const path = `/${url.pathname.replace(/^\/+|\/+$/gu, "")}`;
  if (url.protocol !== "zcode:" || url.hostname !== "zai-auth" || path !== "/callback") {
    throw new Error("Z.AI returned an unexpected OAuth callback target.");
  }
  const state = url.searchParams.get("state") || "";
  if (!state || !statesMatch(state, expectedState)) {
    throw new Error("Z.AI OAuth state did not match. Please retry login.");
  }
  const authorizationError = url.searchParams.get("error_description")
    || url.searchParams.get("error");
  if (authorizationError) {
    throw new Error(`Z.AI authorization failed: ${safeAuthorizationError(authorizationError)}`);
  }
  const code = url.searchParams.get("code") || url.searchParams.get("authCode") || "";
  if (!code) throw new Error("Z.AI OAuth callback did not include an authorization code.");
  return { callbackUrl, code, state };
}

export function parseZaiOAuthCallbackInput(input: string, expectedState: string): ZaiOAuthCallback {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Z.AI OAuth callback did not include an authorization code.");
  const embedded = /zcode:\/\/zai-auth\/callback[^\s]*/u.exec(trimmed);
  if (embedded) return parseZaiOAuthCallback(embedded[0], expectedState);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) {
    return parseZaiOAuthCallback(trimmed, expectedState);
  }
  return parseZaiOAuthCallback(
    `${redirectUri}?code=${encodeURIComponent(trimmed)}&state=${encodeURIComponent(expectedState)}`,
    expectedState
  );
}

function callbackWaitingMessage(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Waiting for the zcode:// callback...\n";
  return [
    "After authorizing, the browser will try to open a zcode:// link.",
    "If this terminal does not continue automatically, copy the full callback URL",
    "from the address bar (it starts with zcode://zai-auth/callback) and paste it below.",
    "Waiting for the zcode:// callback...\n"
  ].join("\n");
}

async function openBrowser(url: string, platform: NodeJS.Platform): Promise<BrowserOpenResult> {
  const { args, command } = browserOpenCommand(platform, url);
  const result = await captureCommand(command, args);
  return result.code === 0
    ? { opened: true }
    : { opened: false, reason: result.stderr.trim() || `${command} exited with status ${result.code}` };
}

export async function runZaiOAuthLogin(options: ZaiOAuthLoginOptions): Promise<number> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const state = options.state ?? randomBytes(32).toString("hex");
  const output = options.output ?? process.stdout;
  const createReceiver = options.createReceiver ?? ((receiverOptions) => (
    platform === "darwin"
      ? createDarwinUrlCallbackReceiver(receiverOptions)
      : createPortableOAuthCallbackReceiver({
        ...receiverOptions,
        input: options.input === undefined ? process.stdin : options.input,
        registerSchemeHandler: options.registerSchemeHandler ?? platform === "linux",
        runCommand: options.runCommand
      })
  ));
  const receiver = await createReceiver({ env, scheme: "zcode" });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await receiver.dispose();
  };

  try {
    const authorizeUrl = buildZaiAuthorizeUrl(state);
    if (options.invocation.noBrowser) {
      output.write(`Open this URL to sign in:\n${authorizeUrl}\n${callbackWaitingMessage(platform)}`);
    } else {
      output.write(`Opening browser for Z.AI authorization.\nFallback URL:\n${authorizeUrl}\n`);
      if (platform !== "darwin") output.write(callbackWaitingMessage(platform));
      const result = await (options.openBrowser ?? ((url) => openBrowser(url, platform)))(authorizeUrl);
      if (!result.opened) {
        output.write(`Browser open failed: ${result.reason ?? "unknown error"}\nOpen the fallback URL manually.\n`);
      }
    }

    const callbackUrl = await receiver.waitForCallback(options.abortSignal, options.timeoutMs);
    const parsed = parseZaiOAuthCallbackInput(callbackUrl, state);
    await dispose();
    output.write("Authorization received. Completing official ZCode setup...\n");
    return await options.completeLogin(
      { callbackUrl: parsed.callbackUrl, state },
      options.invocation.runtimeArgs
    );
  } finally {
    await dispose();
  }
}
