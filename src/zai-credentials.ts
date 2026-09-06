import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

import {
  readConfiguredModelAccess,
  updateUserConfig,
  type ConfiguredModelAccess
} from "./model-access.ts";

export const zaiAccessTokenCredentialKey = "oauth:zai:access_token";

const encryptedPrefix = "enc:v1:";
const credentialSecretEnv = "ZCODE_CREDENTIAL_SECRET";
const dataBaseDirEnv = "ZCODE_DATA_BASE_DIR";
const cipherAlgorithm = "aes-256-gcm";
const ivLength = 12;
const authTagLength = 16;
const zaiApiHost = "https://api.z.ai";
const zaiApiKeyName = "zcode-api-key";
const defaultOrgNameHint = "默认机构";
const defaultProjectNameHint = "默认项目";
const defaultZaiBaseUrl = "https://api.z.ai/api/anthropic";

export interface ZaiCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export interface RemoteCodingPlanRequest {
  body?: Uint8Array;
  headers?: Record<string, string>;
  method: string;
  url: string;
}

export interface RemoteCodingPlanResponse {
  body: Uint8Array;
  status: number;
}

export type CodingPlanRequester = (
  request: RemoteCodingPlanRequest
) => Promise<RemoteCodingPlanResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fallbackHome: string
): string {
  const configured = env[dataBaseDirEnv]?.trim()
    || (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return configured || fallbackHome;
}

export function desktopCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir()
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(dataHome(env, platform, fallbackHome), ".zcode", "v2", "credentials.json");
}

function resolveCredentialSecret(options: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  username?: string;
}): string {
  const fromEnv = options.env?.[credentialSecretEnv]?.trim();
  if (fromEnv) return fromEnv;
  let username = options.username;
  if (!username) {
    try {
      username = userInfo().username;
    } catch {
      username = "unknown";
    }
  }
  return `zcode-credential-fallback:${options.platform ?? process.platform}:${options.homedir ?? homedir()}:${username}`;
}

export function createZaiCredentialCipher(options: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  username?: string;
} = {}): ZaiCredentialCipher {
  const key = createHash("sha256").update(resolveCredentialSecret({
    env: options.env ?? process.env,
    homedir: options.homedir,
    platform: options.platform,
    username: options.username
  })).digest();

  return {
    decrypt(value: string): string {
      if (!value.startsWith(encryptedPrefix)) return value;
      const encoded = value.slice(encryptedPrefix.length);
      const parts = encoded.split(".");
      const [ivText, tagText, cipherText] = parts;
      if (!ivText || !tagText || !cipherText || parts.length !== 3) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }
      const iv = Buffer.from(ivText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      const ciphertext = Buffer.from(cipherText, "base64url");
      if (iv.length !== ivLength) throw new Error("Credential decrypt failed: invalid IV length");
      if (tag.length !== authTagLength) throw new Error("Credential decrypt failed: invalid auth tag length");
      try {
        const decipher = createDecipheriv(cipherAlgorithm, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (error) {
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
          cause: error
        });
      }
    },
    encrypt(value: string): string {
      const iv = randomBytes(ivLength);
      const cipher = createCipheriv(cipherAlgorithm, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        encryptedPrefix,
        iv.toString("base64url"),
        ".",
        tag.toString("base64url"),
        ".",
        encrypted.toString("base64url")
      ].join("");
    }
  };
}

export async function hasZaiOAuthCredentials(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(desktopCredentialsPath(env), "utf8")) as unknown;
    if (!isRecord(record)) return false;
    const value = record[zaiAccessTokenCredentialKey];
    return typeof value === "string" && value.trim().length > 0;
  } catch {
    return false;
  }
}

export async function readZaiAccessToken(
  env: NodeJS.ProcessEnv = process.env,
  cipher: ZaiCredentialCipher = createZaiCredentialCipher({ env })
): Promise<string | null> {
  let record: unknown;
  try {
    record = JSON.parse(await readFile(desktopCredentialsPath(env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Unable to read Z.AI OAuth credentials: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!isRecord(record)) throw new Error("Shared ZCode credentials are corrupt: the root value must be a JSON object.");
  const value = record[zaiAccessTokenCredentialKey];
  if (typeof value !== "string" || !value.trim()) return null;
  const accessToken = cipher.decrypt(value).trim();
  return accessToken || null;
}

function isSuccessfulRemoteCode(code: unknown): boolean {
  return code == null || code === 0 || code === 200 || code === "0" || code === "200";
}

async function defaultRequest(request: RemoteCodingPlanRequest): Promise<RemoteCodingPlanResponse> {
  const response = await fetch(request.url, {
    body: request.body ? Buffer.from(request.body) : undefined,
    headers: request.headers,
    method: request.method
  });
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    status: response.status
  };
}

async function requestRemoteData(
  request: CodingPlanRequester,
  init: RemoteCodingPlanRequest
): Promise<unknown> {
  const response = await request(init);
  const text = new TextDecoder().decode(response.body);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(
      response.status < 200 || response.status >= 300
        ? `Coding Plan HTTP error ${response.status} (empty or non-JSON response)`
        : "Coding Plan response is not valid JSON"
    );
  }
  if (!isRecord(envelope) || !isSuccessfulRemoteCode(envelope.code)) {
    const message = isRecord(envelope) && typeof envelope.msg === "string" && envelope.msg.trim()
      ? envelope.msg.trim()
      : `Remote business error ${String(isRecord(envelope) ? envelope.code : "unknown")}`;
    throw new Error(message);
  }
  return envelope.data ?? null;
}

function pickOrgAndProject(data: unknown): { organizationId: string; projectId: string } | null {
  const organizations = isRecord(data) && Array.isArray(data.organizations) ? data.organizations : [];
  const organization = organizations.find((entry) => {
    const name = isRecord(entry) ? entry.organizationName : undefined;
    return typeof name === "string" && name.includes(defaultOrgNameHint);
  }) ?? organizations[0];
  const organizationRecord = isRecord(organization) ? organization : undefined;
  const projects = organizationRecord && Array.isArray(organizationRecord.projects)
    ? organizationRecord.projects
    : [];
  const project = projects.find((entry) => {
    const name = isRecord(entry) ? entry.projectName : undefined;
    return typeof name === "string" && name.includes(defaultProjectNameHint);
  }) ?? projects[0];
  const projectRecord = isRecord(project) ? project : undefined;
  const organizationId = organizationRecord?.organizationId;
  const projectId = projectRecord?.projectId;
  if (organizationId == null || projectId == null) return null;
  return { organizationId: String(organizationId), projectId: String(projectId) };
}

export async function resolveCodingPlanApiKeyFromAccessToken(
  accessToken: string,
  options: { request?: CodingPlanRequester } = {}
): Promise<string> {
  const token = accessToken.trim();
  if (!token) throw new Error("OAuth access token is required.");
  const request = options.request ?? defaultRequest;
  const login = await requestRemoteData(request, {
    body: new TextEncoder().encode(JSON.stringify({ token })),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    url: `${zaiApiHost}/api/auth/z/login`
  });
  const loginRecord = isRecord(login) ? login : undefined;
  const bizToken = (
    typeof loginRecord?.access_token === "string"
      ? loginRecord.access_token
      : typeof loginRecord?.accessToken === "string"
        ? loginRecord.accessToken
        : ""
  ).trim();
  if (!bizToken) throw new Error("Z.AI biz token response is missing access_token.");

  const authorization = `Bearer ${bizToken}`;
  const customer = await requestRemoteData(request, {
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    method: "GET",
    url: `${zaiApiHost}/api/biz/customer/getCustomerInfo`
  });
  const selected = pickOrgAndProject(customer);
  if (!selected) throw new Error("Unable to resolve organization and project.");

  const keysUrl = `${zaiApiHost}/api/biz/v1/organization/${selected.organizationId}/projects/${selected.projectId}/api_keys`;
  const listed = await requestRemoteData(request, {
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    method: "GET",
    url: keysUrl
  });
  const listedKeys = Array.isArray(listed) ? listed : [];
  let keyRecord = listedKeys.find((entry) => isRecord(entry) && entry.name === zaiApiKeyName);
  if (!isRecord(keyRecord)) {
    keyRecord = await requestRemoteData(request, {
      body: new TextEncoder().encode(JSON.stringify({ name: zaiApiKeyName })),
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      method: "POST",
      url: keysUrl
    });
  }
  const apiKey = (isRecord(keyRecord) && typeof keyRecord.apiKey === "string" ? keyRecord.apiKey : "").trim();
  if (!apiKey) throw new Error("API key response is missing apiKey.");

  const copied = await requestRemoteData(request, {
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    method: "GET",
    url: `${keysUrl}/copy/${encodeURIComponent(apiKey)}`
  });
  const secretKey = (isRecord(copied) && typeof copied.secretKey === "string" ? copied.secretKey : "").trim();
  if (!secretKey) throw new Error("API key copy response is missing secretKey.");
  return `${apiKey}.${secretKey}`;
}

async function writeZaiApiKey(apiKey: string, env: NodeJS.ProcessEnv): Promise<void> {
  await updateUserConfig((config) => {
    const providers = isRecord(config.provider) ? config.provider : {};
    const current = isRecord(providers.zai) ? providers.zai : {};
    const options = isRecord(current.options) ? current.options : {};
    const baseURL = typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL
      : defaultZaiBaseUrl;
    providers.zai = {
      ...current,
      kind: typeof current.kind === "string" && current.kind.trim() ? current.kind : "anthropic",
      options: {
        ...options,
        apiKey,
        apiKeyRequired: true,
        baseURL
      }
    };
    config.provider = providers;
  }, env);
}

export async function hydrateZaiCodingPlanAccess(options: {
  env?: NodeJS.ProcessEnv;
  request?: CodingPlanRequester;
  resolveApiKey?: (accessToken: string) => Promise<string>;
} = {}): Promise<ConfiguredModelAccess | null> {
  const env = options.env ?? process.env;
  const existing = await readConfiguredModelAccess(env);
  if (existing) return existing;
  const accessToken = await readZaiAccessToken(env);
  if (!accessToken) return null;
  const apiKey = options.resolveApiKey
    ? await options.resolveApiKey(accessToken)
    : await resolveCodingPlanApiKeyFromAccessToken(accessToken, { request: options.request });
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Coding Plan API key resolution returned an empty key.");
  }
  await writeZaiApiKey(apiKey.trim(), env);
  return await readConfiguredModelAccess(env);
}
