import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const credentialPrefix = "enc:v1:";
const desktopConfigDirectory = "v2";

export type DesktopOAuthProvider = "zai" | "bigmodel";

export interface DesktopCredentialCipherOptions {
  env?: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
  username?: string;
}

export interface DesktopOAuthTokens {
  accessToken: string;
  jwtToken?: string;
  provider: DesktopOAuthProvider;
  userInfo?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fallbackHome: string): string {
  const configured = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return configured || fallbackHome;
}

function credentialPlatform(platform: NodeJS.Platform): "darwin" | "linux" | "win32" {
  if (platform === "darwin" || platform === "win32") return platform;
  return "linux";
}

function decodeComponent(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function desktopCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(desktopHome(env, platform, fallbackHome), ".zcode", desktopConfigDirectory, "credentials.json");
}

export function desktopCredentialSecret(options: DesktopCredentialCipherOptions): string {
  const env = options.env ?? process.env;
  const configured = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured) return configured;
  const platform = credentialPlatform(options.platform ?? "linux");
  const username = options.username
    ?? env.USER?.trim()
    ?? env.USERNAME?.trim()
    ?? "unknown";
  return `zcode-credential-fallback:${platform}:${options.home}:${username}`;
}

function credentialKey(options: DesktopCredentialCipherOptions): Buffer {
  return createHash("sha256").update(desktopCredentialSecret(options)).digest();
}

export function encryptDesktopCredential(value: string, options: DesktopCredentialCipherOptions): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(options), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${credentialPrefix}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptDesktopCredential(value: string, options: DesktopCredentialCipherOptions): string {
  if (!value.startsWith(credentialPrefix)) return value;
  const encoded = value.slice(credentialPrefix.length);
  const parts = encoded.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("Desktop credential ciphertext is invalid.");
  }
  const iv = decodeComponent(parts[0]!);
  const tag = decodeComponent(parts[1]!);
  const ciphertext = decodeComponent(parts[2]!);
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Desktop credential ciphertext is invalid.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", credentialKey(options), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error("Desktop credential decrypt failed; HOME or user does not match the writer.", {
      cause: error
    });
  }
}

export function tryDecryptDesktopCredential(
  value: string,
  options: DesktopCredentialCipherOptions
): string | undefined {
  try {
    const decrypted = decryptDesktopCredential(value, options).trim();
    return decrypted.length > 0 ? decrypted : undefined;
  } catch {
    return undefined;
  }
}

function parseUserInfo(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readDesktopOAuthTokens(options: {
  env?: NodeJS.ProcessEnv;
  fallbackHome?: string;
  platform?: NodeJS.Platform;
  username?: string;
} = {}): Promise<DesktopOAuthTokens | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fallbackHome = options.fallbackHome ?? homedir();
  const home = desktopHome(env, platform, fallbackHome);
  const cipher = { env, home, platform, username: options.username };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(desktopCredentialsPath(env, platform, fallbackHome), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const active = typeof raw["oauth:active_provider"] === "string"
    ? tryDecryptDesktopCredential(raw["oauth:active_provider"], cipher)
    : undefined;
  const providers: DesktopOAuthProvider[] = active === "bigmodel"
    ? ["bigmodel", "zai"]
    : ["zai", "bigmodel"];

  for (const provider of providers) {
    const accessRaw = raw[`oauth:${provider}:access_token`];
    const access = typeof accessRaw === "string"
      ? tryDecryptDesktopCredential(accessRaw, cipher)
      : undefined;
    if (!access) continue;
    const jwtRaw = raw.zcodejwttoken;
    const jwtToken = typeof jwtRaw === "string"
      ? tryDecryptDesktopCredential(jwtRaw, cipher)
      : undefined;
    const userInfoValue = raw[`oauth:${provider}:user_info`];
    const userInfoRaw = typeof userInfoValue === "string"
      ? tryDecryptDesktopCredential(userInfoValue, cipher)
      : undefined;
    return {
      provider,
      accessToken: access,
      ...(jwtToken ? { jwtToken } : {}),
      ...(parseUserInfo(userInfoRaw) ? { userInfo: parseUserInfo(userInfoRaw) } : {})
    };
  }
  return null;
}
