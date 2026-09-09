import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import defaultUserConfig from "../config.example.json" with { type: "json" };
import {
  desktopAuthSourcesPresent,
  planFirstRunTuiStart
} from "../src/first-run-setup.ts";
import { markSetupPending, userConfigPath } from "../src/model-access.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-first-run-"));
  temporaryDirectories.push(home);
  return home;
}

function linuxEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, USER: "alice" };
}

async function writeCliConfig(home: string, apiKey?: string): Promise<void> {
  const path = userConfigPath({ HOME: home, USERPROFILE: home });
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  const config = structuredClone(defaultUserConfig) as {
    provider: { zai: { options: { apiKey?: string } } };
  };
  if (apiKey !== undefined) config.provider.zai.options.apiKey = apiKey;
  await writeFile(path, JSON.stringify(config));
}

describe("first-run TUI setup start plan", () => {
  test("opens the wizard immediately when setup is pending and no desktop files exist", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    await writeCliConfig(home);
    await markSetupPending(env);

    let resolveCalls = 0;
    const plan = await planFirstRunTuiStart({
      env,
      fallbackHome: home,
      platform: "linux",
      username: "alice",
      resolveApiKey: async () => {
        resolveCalls += 1;
        throw new Error("desktop sync must not run before the wizard can capture Esc");
      }
    });

    expect(plan).toEqual({ action: "open-wizard", hydrateDesktopAuth: false });
    expect(resolveCalls).toBe(0);
  });

  test("does not block first-run on desktop hydration when only CLI config exists", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    await writeCliConfig(home);
    await markSetupPending(env);

    expect(await desktopAuthSourcesPresent({
      env,
      fallbackHome: home,
      platform: "linux"
    })).toBe(false);
  });

  test("marks setup complete when the CLI already has an apiKey", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    await writeCliConfig(home, "already-configured-key");
    await markSetupPending(env);

    expect(await planFirstRunTuiStart({
      env,
      fallbackHome: home,
      platform: "linux",
      username: "alice"
    })).toEqual({ action: "complete-setup" });
  });

  test("stays idle when first-run is not pending", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    await writeCliConfig(home);

    expect(await planFirstRunTuiStart({
      env,
      fallbackHome: home,
      platform: "linux"
    })).toEqual({ action: "idle" });
  });

  test("allows desktop hydration only after the wizard is allowed to open when sources exist", async () => {
    const home = await temporaryHome();
    const env = linuxEnv(home);
    await writeCliConfig(home);
    await markSetupPending(env);
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(join(home, ".zcode", "v2", "credentials.json"), "{}");

    let resolveCalls = 0;
    const plan = await planFirstRunTuiStart({
      env,
      fallbackHome: home,
      platform: "linux",
      username: "alice",
      resolveApiKey: async () => {
        resolveCalls += 1;
        return "should-not-run-during-plan";
      }
    });

    expect(plan).toEqual({ action: "open-wizard", hydrateDesktopAuth: true });
    expect(resolveCalls).toBe(0);
    expect(await desktopAuthSourcesPresent({
      env,
      fallbackHome: home,
      platform: "linux"
    })).toBe(true);
  });
});
