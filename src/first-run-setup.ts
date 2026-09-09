import { stat } from "node:fs/promises";
import { homedir } from "node:os";

import { type SyncCliAuthOptions } from "./cli-auth-sync.ts";
import { desktopCredentialsPath } from "./desktop-credentials.ts";
import { desktopConfigPath } from "./desktop-migration.ts";
import { readConfiguredModelAccess, readSetupPending } from "./model-access.ts";

export type FirstRunTuiStartPlan =
  | { action: "idle" }
  | { action: "complete-setup" }
  | { action: "open-wizard"; hydrateDesktopAuth: boolean };

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function desktopAuthSourcesPresent(
  options: SyncCliAuthOptions = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fallbackHome = options.fallbackHome ?? homedir();
  const [credentials, desktopConfig] = await Promise.all([
    pathIsFile(desktopCredentialsPath(env, platform, fallbackHome)),
    pathIsFile(desktopConfigPath(env, platform, fallbackHome))
  ]);
  return credentials || desktopConfig;
}

export async function planFirstRunTuiStart(
  options: SyncCliAuthOptions = {}
): Promise<FirstRunTuiStartPlan> {
  const env = options.env ?? process.env;
  if (!await readSetupPending(env)) return { action: "idle" };
  if (await readConfiguredModelAccess(env)) return { action: "complete-setup" };
  return {
    action: "open-wizard",
    hydrateDesktopAuth: await desktopAuthSourcesPresent(options)
  };
}
