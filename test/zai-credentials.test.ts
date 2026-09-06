import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import defaultUserConfig from "../config.example.json" with { type: "json" };
import {
  applyDesktopMigration,
  detectDesktopInstallation
} from "../src/desktop-migration.ts";
import {
  createZaiCredentialCipher,
  desktopCredentialsPath,
  hasZaiOAuthCredentials,
  hydrateZaiCodingPlanAccess,
  readZaiAccessToken,
  resolveCodingPlanApiKeyFromAccessToken,
  zaiAccessTokenCredentialKey
} from "../src/zai-credentials.ts";
import { missingCodingPlanKey } from "../src/prompt-preflight.ts";
import { promptPreflight } from "../src/launcher.ts";
import { readConfiguredModelAccess, userConfigPath } from "../src/model-access.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-credentials-"));
  directories.push(home);
  const env = {
    HOME: home,
    USERPROFILE: home,
    ZCODE_CREDENTIAL_SECRET: "fixture-credential-secret"
  };
  const configPath = userConfigPath(env);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(defaultUserConfig));
  return { env, home, configPath };
}

async function writeCredentials(
  env: NodeJS.ProcessEnv,
  value: string,
  encrypt = true
): Promise<string> {
  const path = desktopCredentialsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const stored = encrypt
    ? createZaiCredentialCipher({ env }).encrypt(value)
    : value;
  await writeFile(path, JSON.stringify({
    [zaiAccessTokenCredentialKey]: stored
  }));
  return path;
}

function encodeEnvelope(data: unknown, code: unknown = 0): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ code, data, msg: "ok" }));
}

describe("shared Z.AI OAuth credentials", () => {
  test("round-trips official enc:v1 values and accepts plaintext tokens", async () => {
    const { env } = await fixture();
    const cipher = createZaiCredentialCipher({ env });
    const encrypted = cipher.encrypt("oauth-access-token");
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe("oauth-access-token");
    expect(cipher.decrypt("plaintext-token")).toBe("plaintext-token");

    await writeCredentials(env, "oauth-access-token");
    expect(await hasZaiOAuthCredentials(env)).toBe(true);
    expect(await readZaiAccessToken(env)).toBe("oauth-access-token");

    await writeCredentials(env, "plain-oauth-token", false);
    expect(await readZaiAccessToken(env)).toBe("plain-oauth-token");
  });

  test("resolves a Coding Plan API key through the official biz endpoints", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const key = await resolveCodingPlanApiKeyFromAccessToken("oauth-access-token", {
      request: async (request) => {
        calls.push({ method: request.method, url: request.url });
        if (request.url.endsWith("/api/auth/z/login")) {
          expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
            token: "oauth-access-token"
          });
          return { status: 200, body: encodeEnvelope({ access_token: "biz-token" }) };
        }
        if (request.url.endsWith("/api/biz/customer/getCustomerInfo")) {
          expect(request.headers?.Authorization).toBe("Bearer biz-token");
          return {
            status: 200,
            body: encodeEnvelope({
              organizations: [
                {
                  organizationId: "org-1",
                  organizationName: "默认机构",
                  projects: [{ projectId: "proj-1", projectName: "默认项目" }]
                }
              ]
            })
          };
        }
        if (request.url.endsWith("/api_keys") && request.method === "GET") {
          return { status: 200, body: encodeEnvelope([]) };
        }
        if (request.url.endsWith("/api_keys") && request.method === "POST") {
          expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
            name: "zcode-api-key"
          });
          return { status: 200, body: encodeEnvelope({ apiKey: "key-id", name: "zcode-api-key" }) };
        }
        if (request.url.endsWith("/api_keys/copy/key-id")) {
          return { status: 200, body: encodeEnvelope({ secretKey: "secret-half" }) };
        }
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      }
    });
    expect(key).toBe("key-id.secret-half");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
  });

  test("hydrates config.json from existing OAuth credentials so prompts are unblocked", async () => {
    const { env, configPath } = await fixture();
    await writeCredentials(env, "oauth-access-token");
    expect(await readConfiguredModelAccess(env)).toBeNull();
    expect(await missingCodingPlanKey({ env, workingDirectory: env.HOME })).toContain("No model request was sent");

    const access = await hydrateZaiCodingPlanAccess({
      env,
      resolveApiKey: async (token) => {
        expect(token).toBe("oauth-access-token");
        return "coding-plan-key";
      }
    });
    expect(access).toEqual({
      configPath,
      model: "zai/glm-5.2",
      providerId: "zai"
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      provider: { zai: { options: { apiKey?: string } } };
    };
    expect(config.provider.zai.options.apiKey).toBe("coding-plan-key");
    expect(await missingCodingPlanKey({ env, workingDirectory: env.HOME })).toBeUndefined();
    expect(await promptPreflight(["-p", "reply with exactly OK"], env)).toBeUndefined();
  });

  test("prompt preflight hydrates existing OAuth credentials before blocking -p", async () => {
    const { env, configPath } = await fixture();
    await writeCredentials(env, "oauth-access-token");
    let resolved = false;
    expect(await promptPreflight(["-p", "reply with exactly OK"], env, {
      hydrateAccess: async (options) => await hydrateZaiCodingPlanAccess({
        env: options?.env ?? env,
        resolveApiKey: async () => {
          resolved = true;
          return "from-oauth";
        }
      })
    })).toBeUndefined();
    expect(resolved).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey).toBe("from-oauth");
  });

  test("desktop import plus existing OAuth tokens produces model access", async () => {
    const { env, home, configPath } = await fixture();
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(join(home, ".zcode", "v2", "config.json"), JSON.stringify({
      provider: {
        "builtin:zai-coding-plan": {
          name: "Z.ai - Coding Plan",
          kind: "anthropic",
          options: { baseURL: "https://api.z.ai/api/anthropic", apiKey: "" },
          models: { "GLM-5.2": { name: "GLM-5.2" }, "GLM-5-Turbo": { name: "GLM-5-Turbo" } }
        }
      }
    }));
    await writeCredentials(env, "oauth-access-token");

    const installation = await detectDesktopInstallation(env);
    await applyDesktopMigration(installation!.plan, { env });
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey).toBeUndefined();

    const access = await hydrateZaiCodingPlanAccess({
      env,
      resolveApiKey: async () => "imported-oauth-key"
    });
    expect(access?.providerId).toBe("zai");
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey).toBe("imported-oauth-key");
    expect(await promptPreflight(["-p", "reply with exactly OK"], env)).toBeUndefined();
  });

  test("does not invent credentials when the OAuth store is empty", async () => {
    const { env } = await fixture();
    expect(await hasZaiOAuthCredentials(env)).toBe(false);
    expect(await hydrateZaiCodingPlanAccess({
      env,
      resolveApiKey: async () => {
        throw new Error("resolver should not run");
      }
    })).toBeNull();
    expect(await missingCodingPlanKey({ env, workingDirectory: env.HOME })).toContain("No model request was sent");
  });
});
