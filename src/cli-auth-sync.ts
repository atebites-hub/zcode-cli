import { homedir } from "node:os";

import { resolveCodingPlanApiKey } from "./coding-plan-key.ts";
import { readDesktopOAuthTokens, tryDecryptDesktopCredential } from "./desktop-credentials.ts";
import { detectDesktopInstallation, type DesktopFamily } from "./desktop-migration.ts";
import { readUserConfig, updateUserConfig, type UserConfigRecord } from "./model-access.ts";

export type CliAuthSyncResult =
  | { status: "already-configured"; providerId: DesktopFamily }
  | { status: "synced-from-desktop-key"; providerId: DesktopFamily }
  | { status: "synced-from-oauth"; providerId: DesktopFamily }
  | {
    status: "unavailable";
    reason: "no-config" | "no-tokens" | "decrypt-failed" | "resolve-failed";
    message?: string;
  };

export interface SyncCliAuthOptions {
  env?: NodeJS.ProcessEnv;
  fallbackHome?: string;
  platform?: NodeJS.Platform;
  resolveApiKey?: (accessToken: string, provider: DesktopFamily) => Promise<string>;
  username?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerIdFromConfig(config: UserConfigRecord): DesktopFamily {
  const model = isRecord(config.model) && typeof config.model.main === "string"
    ? config.model.main
    : "";
  return model.split("/", 1)[0] === "bigmodel" ? "bigmodel" : "zai";
}

function rawProviderApiKey(config: UserConfigRecord, providerId: string): string | undefined {
  const providers = isRecord(config.provider) ? config.provider : undefined;
  const provider = isRecord(providers?.[providerId]) ? providers[providerId] : undefined;
  const options = isRecord(provider?.options) ? provider.options : undefined;
  return typeof options?.apiKey === "string" ? options.apiKey : undefined;
}

function usableApiKey(
  raw: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  username?: string
): string | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  if (!value.startsWith("enc:v1:")) return value;
  return tryDecryptDesktopCredential(value, { env, home, platform, username });
}

async function writeProviderApiKey(
  providerId: DesktopFamily,
  apiKey: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  if (!apiKey.trim() || apiKey.trim().startsWith("enc:v1:")) {
    throw new Error("Refusing to write an empty or still-encrypted API key.");
  }
  await updateUserConfig((config) => {
    const providers = isRecord(config.provider) ? config.provider : {};
    const current = isRecord(providers[providerId])
      ? providers[providerId] as Record<string, unknown>
      : {} as Record<string, unknown>;
    const currentOptions = isRecord(current.options) ? current.options : {};
    providers[providerId] = {
      ...current,
      options: {
        ...currentOptions,
        apiKeyRequired: true,
        apiKey: apiKey.trim()
      }
    };
    config.provider = providers;
  }, env);
}

export function cliAuthUnlockLabel(status: CliAuthSyncResult["status"] | undefined): string {
  switch (status) {
    case "synced-from-oauth":
      return "desktop OAuth tokens";
    case "synced-from-desktop-key":
      return "desktop provider credentials";
    case "already-configured":
      return "existing CLI credentials";
    case "unavailable":
    case undefined:
      return "existing CLI credentials";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export async function syncCliAuthFromDesktop(
  options: SyncCliAuthOptions = {}
): Promise<CliAuthSyncResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fallbackHome = options.fallbackHome ?? homedir();
  const home = ((platform === "win32" ? env.USERPROFILE : env.HOME)?.trim()) || fallbackHome;

  let config: UserConfigRecord;
  try {
    config = await readUserConfig(env);
  } catch {
    return { status: "unavailable", reason: "no-config" };
  }

  const providerId = providerIdFromConfig(config);
  const existing = usableApiKey(rawProviderApiKey(config, providerId), env, platform, home, options.username);
  if (existing) {
    const raw = rawProviderApiKey(config, providerId);
    if (raw?.trim().startsWith("enc:v1:")) {
      await writeProviderApiKey(providerId, existing, env);
      return { status: "synced-from-desktop-key", providerId };
    }
    return { status: "already-configured", providerId };
  }

  const installation = await detectDesktopInstallation(env, platform, fallbackHome, options.username);
  const desktopKey = installation?.plan.families.find((entry) => entry.family === providerId)?.apiKey
    ?? installation?.plan.families.find((entry) => entry.apiKey)?.apiKey;
  if (desktopKey) {
    await writeProviderApiKey(providerId, desktopKey, env);
    return { status: "synced-from-desktop-key", providerId };
  }

  const tokens = await readDesktopOAuthTokens({
    env,
    fallbackHome,
    platform,
    username: options.username
  });
  if (!tokens || tokens.provider !== providerId) {
    return { status: "unavailable", reason: "no-tokens" };
  }
  if (tokens.provider !== "zai" && !options.resolveApiKey) {
    return { status: "unavailable", reason: "no-tokens" };
  }

  try {
    const resolve = options.resolveApiKey
      ?? (async (accessToken: string) => await resolveCodingPlanApiKey(accessToken));
    const apiKey = (await resolve(tokens.accessToken, tokens.provider)).trim();
    if (!apiKey || apiKey.startsWith("enc:v1:")) {
      return { status: "unavailable", reason: "resolve-failed", message: "resolver returned an unusable key" };
    }
    await writeProviderApiKey(providerId, apiKey, env);
    return { status: "synced-from-oauth", providerId };
  } catch (error) {
    return {
      status: "unavailable",
      reason: "resolve-failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
