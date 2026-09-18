import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

<<<<<<< HEAD
import { syncCliAuthFromDesktop, type SyncCliAuthOptions } from "./cli-auth-sync.ts";
import { userConfigPath } from "./model-access.ts";
=======
import { providerConfigPath, hasConfiguredProviderAccess } from "./model-access.ts";
>>>>>>> upstream/main

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    // An unreadable override is also a reason to defer to the runtime.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Diagnose only unambiguous keyless Coding Plan configs, not general model access. */
export async function missingCodingPlanKey(options: {
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  model?: string;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (Object.entries(env).some(([key, value]) => value?.trim()
    && key !== "ZCODE_BASE_URL" && !key.startsWith("ZCODE_MODEL_RETRY_")
    && key !== "ZCODE_MODEL_TELEMETRY_ENABLED"
    && /^(?:ZCODE|ZAI|BIGMODEL|ZHIPU|ANTHROPIC)_.*(?:KEY|TOKEN|MODEL|CONFIG|PROVIDER|BASE_URL)/u.test(key))) {
    return undefined;
  }
  let directory = resolve(options.workingDirectory ?? process.cwd());
  while (true) {
    if ((await Promise.all([
      join(directory, "zcode.json"),
      join(directory, ".zcode", "config.json"),
      join(directory, ".env")
    ].map(exists))).some(Boolean)) return undefined;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const message = (providerId?: string) => `Model access is not configured${providerId ? ` for ${providerId}` : ""}. Run /login or /setup in zcode, `
    + "or configure its API key before sending a prompt. No model request was sent.";
  let root: Record<string, unknown> | undefined;
  try {
    root = record(JSON.parse(await readFile(providerConfigPath(env), "utf8")));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && !options.model ? message() : undefined;
  }
  const config = record(root?.config);
  if (root?.schemaVersion !== 1 || !config) return undefined;
  const selection = record(config.defaultModelSelection);
  const model = options.model ?? (typeof selection?.providerId === "string" && typeof selection.modelId === "string"
    ? `${selection.providerId}/${selection.modelId}` : undefined);
  if (!model) return await hasConfiguredProviderAccess(env) ? undefined : message();
  const separator = model.indexOf("/");
  if (separator <= 0) return undefined;
  const providerId = model.slice(0, separator), modelId = model.slice(separator + 1);
  // Account credentials are encrypted and validated by the runtime.
  if (providerId.startsWith("account:")) return undefined;
  const rules = record(config.providerConfigRules)?.providerRules;
  if (!Array.isArray(rules)) return undefined;
  const provider = rules.map(record).find((rule) => rule?.providerId === providerId);
  const settings = record(provider?.config), auth = record(settings?.access), api = record(settings?.api);
  if (!settings || !["api-key", "zhipu-coding-plan-api-key"].includes(String(auth?.type))
    || typeof auth?.apiKey === "string" && auth.apiKey.trim()
    || auth?.apiKey !== undefined && typeof auth.apiKey !== "string"
    || Object.keys(record(api?.headers) ?? {}).length > 0
    || Array.isArray(settings.personalModelIds) && !settings.personalModelIds.includes(modelId)) return undefined;
  return message(providerId);
}

export async function ensureCodingPlanAccess(options: {
  env?: NodeJS.ProcessEnv;
  fallbackHome?: string;
  model?: string;
  platform?: NodeJS.Platform;
  resolveApiKey?: SyncCliAuthOptions["resolveApiKey"];
  username?: string;
  workingDirectory?: string;
} = {}): Promise<string | undefined> {
  const sync = await syncCliAuthFromDesktop({
    env: options.env,
    fallbackHome: options.fallbackHome,
    platform: options.platform,
    resolveApiKey: options.resolveApiKey,
    username: options.username
  });
  if (sync.status === "unavailable") {
    switch (sync.reason) {
      case "resolve-failed":
        return "Desktop OAuth tokens were found but a Coding Plan API key could not be resolved. "
          + `${sync.message ?? "Key resolution failed."} Run /login or configure its API key `
          + "before sending a prompt. No model request was sent.";
      case "decrypt-failed":
        return "Desktop OAuth credentials could not be decrypted for this user or HOME. "
          + "Run /login or configure its API key before sending a prompt. No model request was sent.";
      case "no-config":
      case "no-tokens":
        break;
      default: {
        const _exhaustive: never = sync.reason;
        return _exhaustive;
      }
    }
  }
  return missingCodingPlanKey(options);
}
