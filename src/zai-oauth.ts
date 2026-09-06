import { randomBytes, timingSafeEqual } from "node:crypto";
import { stdin } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  createDarwinUrlCallbackReceiver,
  type DarwinUrlCallbackReceiver
} from "./darwin-oauth-callback.ts";
import { captureCommand } from "./command.ts";

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
  }) => Promise<DarwinUrlCallbackReceiver>;
  env?: NodeJS.ProcessEnv;
  invocation: ZaiOAuthInvocation;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  output?: WritableOutput;
  platform?: NodeJS.Platform;
  readCallbackLine?: () => Promise<string>;
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

function browserOpenCommand(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "/usr/bin/open";
  if (platform === "linux") return "xdg-open";
  return undefined;
}

async function openBrowser(url: string, platform: NodeJS.Platform): Promise<BrowserOpenResult> {
  const command = browserOpenCommand(platform);
  if (!command) {
    return { opened: false, reason: `no browser opener for ${platform}` };
  }
  const result = await captureCommand(command, [url]);
  return result.code === 0
    ? { opened: true }
    : { opened: false, reason: result.stderr.trim() || `${command} exited with status ${result.code}` };
}

export async function readCallbackLineFromStdin(): Promise<string> {
  const rl = createInterface({ crlfDelay: Infinity, input: stdin });
  try {
    return await new Promise<string>((resolve, reject) => {
      const succeed = (line: string) => {
        rl.off("close", onClose);
        resolve(line);
      };
      const onClose = () => {
        reject(new Error("Stdin closed before a zcode:// callback URL was provided."));
      };
      rl.once("line", succeed);
      rl.once("close", onClose);
    });
  } finally {
    rl.close();
  }
}

export async function waitForPastedCallbackUrl(options: {
  readLine: () => Promise<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const read = options.readLine();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for the zcode:// callback URL.")),
      timeoutMs
    );
    timer.unref?.();
  });
  const abort = options.signal
    ? new Promise<string>((_, reject) => {
      const onAbort = () => reject(options.signal?.reason ?? new Error("Login cancelled."));
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
    })
    : undefined;
  try {
    const line = await Promise.race([read, timeout, ...(abort ? [abort] : [])]);
    const trimmed = line.trim();
    if (!trimmed) throw new Error("A zcode:// callback URL is required to finish login.");
    return trimmed;
  } finally {
    if (timer) clearTimeout(timer);
    read.catch(() => {});
  }
}

function createStdinCallbackReceiver(
  readLine: () => Promise<string>
): DarwinUrlCallbackReceiver {
  return {
    async dispose() {},
    async waitForCallback(signal, timeoutMs) {
      return await waitForPastedCallbackUrl({ readLine, signal, timeoutMs });
    }
  };
}

export async function runZaiOAuthLogin(options: ZaiOAuthLoginOptions): Promise<number> {
  const platform = options.platform ?? process.platform;
  const nativeCallback = platform === "darwin";
  const env = options.env ?? process.env;
  const state = options.state ?? randomBytes(32).toString("hex");
  const output = options.output ?? process.stdout;
  const createReceiver = options.createReceiver ?? (nativeCallback
    ? (receiverOptions) => createDarwinUrlCallbackReceiver(receiverOptions)
    : async () => createStdinCallbackReceiver(options.readCallbackLine ?? readCallbackLineFromStdin));
  const receiver = await createReceiver({ env, scheme: "zcode" });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await receiver.dispose();
  };

  try {
    const authorizeUrl = buildZaiAuthorizeUrl(state);
    if (options.invocation.noBrowser || !nativeCallback) {
      output.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
      output.write(
        nativeCallback
          ? "Waiting for the zcode:// callback...\n"
          : "After the browser redirects to a zcode:// URL, paste that callback URL here and press Enter.\n"
            + "Waiting for the zcode:// callback URL...\n"
      );
    } else {
      output.write(`Opening browser for Z.AI authorization.\nFallback URL:\n${authorizeUrl}\n`);
    }
    if (!options.invocation.noBrowser) {
      const result = await (options.openBrowser ?? ((url) => openBrowser(url, platform)))(authorizeUrl);
      if (!result.opened) {
        output.write(
          `Browser open failed: ${result.reason ?? "unknown error"}\n`
          + (nativeCallback ? "Open the fallback URL manually.\n" : "Open the sign-in URL in a browser, then paste the zcode:// callback URL.\n")
        );
      }
    }

    const callbackUrl = await receiver.waitForCallback(options.abortSignal, options.timeoutMs);
    parseZaiOAuthCallback(callbackUrl, state);
    await dispose();
    output.write("Authorization received. Completing official ZCode setup...\n");
    return await options.completeLogin({ callbackUrl, state }, options.invocation.runtimeArgs);
  } finally {
    await dispose();
  }
}
