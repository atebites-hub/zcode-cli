import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProviderFixture } from "./fixtures/provider-config.ts";
import {
  planFirstRunTuiStart
} from "../src/first-run-setup.ts";
import { markSetupPending } from "../src/model-access.ts";

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
  await writeProviderFixture(linuxEnv(home), { apiKey });
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

    expect(plan).toEqual({ action: "open-wizard" });
    expect(resolveCalls).toBe(0);
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

  test("does not resolve legacy OAuth tokens before opening the native setup wizard", async () => {
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

    expect(plan).toEqual({ action: "open-wizard" });
    expect(resolveCalls).toBe(0);
  });
});
