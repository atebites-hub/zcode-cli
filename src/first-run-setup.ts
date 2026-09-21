import { type SyncCliAuthOptions } from "./cli-auth-sync.ts";
import { hasConfiguredProviderAccess, readSetupPending } from "./model-access.ts";

export type FirstRunTuiStartPlan =
  | { action: "idle" }
  | { action: "complete-setup" }
  | { action: "open-wizard" };

export async function planFirstRunTuiStart(options: SyncCliAuthOptions = {}): Promise<FirstRunTuiStartPlan> {
  const env = options.env ?? process.env;
  if (!await readSetupPending(env)) return { action: "idle" };
  if (await hasConfiguredProviderAccess(env)) return { action: "complete-setup" };
  return { action: "open-wizard" };
}
