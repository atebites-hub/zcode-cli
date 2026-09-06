import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import defaultUserConfig from "../config.example.json" with { type: "json" };
import { cliAuthUnlockLabel, syncCliAuthFromDesktop } from "../src/cli-auth-sync.ts";
import { encryptDesktopCredential } from "../src/desktop-credentials.ts";
import { applyDesktopMigration, detectDesktopInstallation } from "../src/desktop-migration.ts";
import { userConfigPath } from "../src/model-access.ts";
import { ensureCodingPlanAccess, missingCodingPlanKey } from "../src/prompt-preflight.ts";
import { promptPreflight } from "../src/launcher.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-cli-auth-sync-"));
  temporaryDirectories.push(home);
  return home;
}

const desktopConfig = {
  provider: {
    "builtin:zai-coding-plan": {
      name: "Z.ai - Coding Plan",
      kind: "anthropic",
      options: { baseURL: "https://api.z.ai/api/anthropic", apiKey: "" },
      models: {
        "glm-5.2": { name: "GLM-5.2" },
        "glm-5-turbo": { name: "GLM-5-Turbo" }
      }
    }
  }
};

async function writeDesktop(home: string, options: {
  apiKey?: string;
  credentials?: Record<string, string>;
} = {}): Promise<void> {
  await mkdir(join(home, ".zcode", "v2"), { recursive: true });
  const config = structuredClone(desktopConfig);
  if (options.apiKey !== undefined) {
    config.provider["builtin:zai-coding-plan"].options.apiKey = options.apiKey;
  }
  await writeFile(join(home, ".zcode", "v2", "config.json"), JSON.stringify(config));
  if (options.credentials) {
    await writeFile(join(home, ".zcode", "v2", "credentials.json"), JSON.stringify(options.credentials));
  }
}

async function writeCliConfig(home: string): Promise<string> {
  const path = userConfigPath({ HOME: home, USERPROFILE: home });
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(path, JSON.stringify(defaultUserConfig));
  return path;
}

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, USER: "alice" };
}

describe("CLI auth sync from desktop tokens", () => {
  test("maps desktop OAuth tokens onto provider.zai.options.apiKey on Linux", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const cipher = { env, home, platform: "linux" as const, username: "alice" };
    await writeCliConfig(home);
    await writeDesktop(home, {
      credentials: {
        "oauth:active_provider": encryptDesktopCredential("zai", cipher),
        "oauth:zai:access_token": encryptDesktopCredential("desktop-oauth-token", cipher)
      }
    });

    let resolved: string | undefined;
    const result = await syncCliAuthFromDesktop({
      env,
      platform: "linux",
      fallbackHome: home,
      username: "alice",
      resolveApiKey: async (accessToken) => {
        resolved = accessToken;
        return "coding-plan-key-from-token";
      }
    });

    expect(result).toEqual({ status: "synced-from-oauth", providerId: "zai" });
    expect(resolved).toBe("desktop-oauth-token");
    const config = JSON.parse(await readFile(userConfigPath(env), "utf8"));
    expect(config.provider.zai.options.apiKey).toBe("coding-plan-key-from-token");
  });

  test("keeps an existing CLI apiKey and does not call the resolver", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const path = await writeCliConfig(home);
    const config = JSON.parse(await readFile(path, "utf8"));
    config.provider.zai.options.apiKey = "cli-existing-key";
    await writeFile(path, JSON.stringify(config));
    await writeDesktop(home, {
      credentials: {
        "oauth:zai:access_token": "should-not-be-used"
      }
    });

    let called = false;
    const result = await syncCliAuthFromDesktop({
      env,
      platform: "linux",
      fallbackHome: home,
      resolveApiKey: async () => {
        called = true;
        return "should-not-write";
      }
    });
    expect(result).toEqual({ status: "already-configured", providerId: "zai" });
    expect(called).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).provider.zai.options.apiKey).toBe("cli-existing-key");
  });

  test("copies a usable desktop provider apiKey without a network resolve", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    await writeCliConfig(home);
    await writeDesktop(home, { apiKey: "desktop-plain-key" });

    let called = false;
    const result = await syncCliAuthFromDesktop({
      env,
      platform: "linux",
      fallbackHome: home,
      username: "alice",
      resolveApiKey: async () => {
        called = true;
        return "network-key";
      }
    });
    expect(result).toEqual({ status: "synced-from-desktop-key", providerId: "zai" });
    expect(called).toBe(false);
    expect(JSON.parse(await readFile(userConfigPath(env), "utf8")).provider.zai.options.apiKey)
      .toBe("desktop-plain-key");
  });

  test("fails closed when tokens cannot unlock a Coding Plan key", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const path = await writeCliConfig(home);
    await writeDesktop(home, {
      credentials: { "oauth:zai:access_token": "desktop-oauth-token" }
    });

    const result = await syncCliAuthFromDesktop({
      env,
      platform: "linux",
      fallbackHome: home,
      resolveApiKey: async () => {
        throw new Error("upstream rejected token");
      }
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("resolve-failed");
      expect(result.message).toContain("upstream rejected token");
    }
    expect(JSON.parse(await readFile(path, "utf8")).provider.zai.options.apiKey).toBeUndefined();
  });
});

describe("desktop import plus token mapping", () => {
  test("import then auto-sync unlocks zcode -p without a pasted key", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const cipher = { env, home, platform: "linux" as const, username: "alice" };
    const configPath = await writeCliConfig(home);
    await writeDesktop(home, {
      credentials: {
        "oauth:zai:access_token": encryptDesktopCredential("desktop-oauth-token", cipher)
      }
    });

    const installation = await detectDesktopInstallation(env, "linux", home);
    await applyDesktopMigration(installation!.plan, { env, family: "zai" });
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey).toBeUndefined();
    expect(await missingCodingPlanKey({ env, workingDirectory: home })).toBeDefined();

    const diagnostic = await ensureCodingPlanAccess({
      env,
      workingDirectory: home,
      platform: "linux",
      fallbackHome: home,
      username: "alice",
      resolveApiKey: async () => "imported-coding-plan-key"
    });
    expect(diagnostic).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey)
      .toBe("imported-coding-plan-key");
    expect(await promptPreflight(["-p", "hello"], env)).toBeUndefined();
  });

  test("zcode -p auto-syncs desktop OAuth tokens before the keyless preflight", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const cipher = { env, home, platform: "linux" as const, username: "alice" };
    const configPath = await writeCliConfig(home);
    await writeDesktop(home, {
      credentials: {
        "oauth:zai:access_token": encryptDesktopCredential("desktop-oauth-token", cipher)
      }
    });
    const installation = await detectDesktopInstallation(env, "linux", home);
    await applyDesktopMigration(installation!.plan, { env, family: "zai" });

    expect(await promptPreflight(["-p", "hello"], env, {
      fallbackHome: home,
      platform: "linux",
      username: "alice",
      resolveApiKey: async (accessToken) => {
        expect(accessToken).toBe("desktop-oauth-token");
        return "preflight-coding-plan-key";
      }
    })).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey)
      .toBe("preflight-coding-plan-key");
  });

  test("zcode -p does not unlock when token mapping fails", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const configPath = await writeCliConfig(home);
    await writeDesktop(home, {
      credentials: { "oauth:zai:access_token": "desktop-oauth-token" }
    });

    expect(await promptPreflight(["-p", "hello"], env, {
      fallbackHome: home,
      platform: "linux",
      username: "alice",
      resolveApiKey: async () => {
        throw new Error("upstream rejected token");
      }
    })).toContain("could not be resolved");
    expect(JSON.parse(await readFile(configPath, "utf8")).provider.zai.options.apiKey).toBeUndefined();
  });

  test("labels the unlock source for each sync status", () => {
    expect(cliAuthUnlockLabel("synced-from-oauth")).toBe("desktop OAuth tokens");
    expect(cliAuthUnlockLabel("synced-from-desktop-key")).toBe("desktop provider credentials");
    expect(cliAuthUnlockLabel("already-configured")).toBe("existing CLI credentials");
    expect(cliAuthUnlockLabel("unavailable")).toBe("existing CLI credentials");
    expect(cliAuthUnlockLabel(undefined)).toBe("existing CLI credentials");
  });

  test("import copies a decrypted desktop apiKey when OAuth tokens are absent", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    const cipher = { env, home, platform: "linux" as const, username: "alice" };
    await writeCliConfig(home);
    await writeDesktop(home, {
      apiKey: encryptDesktopCredential("enc-desktop-key", cipher)
    });

    const installation = await detectDesktopInstallation(env, "linux", home, "alice");
    expect(installation!.plan.families[0]?.apiKey).toBe("enc-desktop-key");
    await applyDesktopMigration(installation!.plan, { env });
    expect(JSON.parse(await readFile(userConfigPath(env), "utf8")).provider.zai.options.apiKey)
      .toBe("enc-desktop-key");
  });
});
