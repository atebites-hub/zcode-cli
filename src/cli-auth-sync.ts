import { readConfiguredModelAccess } from "./model-access.ts";

export interface SyncCliAuthOptions {
  env?: NodeJS.ProcessEnv;
  fallbackHome?: string;
  platform?: NodeJS.Platform;
  resolveApiKey?: (accessToken: string, provider: "zai" | "bigmodel") => Promise<string>;
  username?: string;
}

/** Native account credentials and providers are shared with Desktop since 3.12.3. */
export async function syncCliAuthFromDesktop(options: SyncCliAuthOptions = {}) {
  const access = await readConfiguredModelAccess(options.env);
  return access
    ? { status: "already-configured" as const, providerId: access.providerId }
    : { status: "unavailable" as const, reason: "no-config" as const };
}
