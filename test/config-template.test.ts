import { expect, test } from "bun:test";
import { join } from "node:path";

interface TemplateProvider {
  kind: string;
  options: {
    apiKey?: string;
    baseURL: string;
  };
  models: Record<string, unknown>;
}

interface ConfigTemplate {
  provider: Record<string, TemplateProvider>;
  model: {
    main: string;
    mainThoughtLevel: string;
    lite: string;
    liteThoughtLevel: string;
  };
  modelStream: {
    idleTimeoutMs: number;
  };
  subagents: {
    autoBackgroundMs: number;
  };
  ui: {
    theme: string;
    copyOnSelect: boolean;
    notifications: {
      method: string;
      condition: string;
    };
  };
  hooks: {
    enabled: boolean;
    events: Record<string, unknown[]>;
  };
}

test("custom-provider config template is internally consistent", async () => {
  const file = Bun.file(join(import.meta.dir, "..", "config.example.json"));
  const config = (await file.json()) as ConfigTemplate;
  const [providerId, modelId] = config.model.main.split("/", 2);

  const [liteProviderId, liteModelId] = config.model.lite.split("/", 2);
  expect(providerId).toBe("zai");
  expect(liteProviderId).toBe(providerId);
  expect(config.provider[providerId]?.kind).toBe("anthropic");
  expect(config.provider[providerId]?.models[modelId]).toBeDefined();
  expect(config.provider[providerId]?.models[liteModelId]).toBeDefined();
  expect(config.provider[providerId]?.options.apiKey).toBeUndefined();
  expect(config.provider[providerId]?.options.baseURL).toBe("https://api.z.ai/api/anthropic");
  expect(config.modelStream.idleTimeoutMs).toBe(60_000);
  expect(config.subagents.autoBackgroundMs).toBe(1_000);
  expect(config.ui.theme).toBe("auto");
  expect(config.ui.copyOnSelect).toBe(true);
  expect(config.ui.notifications).toEqual({ method: "auto", condition: "unfocused" });
  expect(config.hooks.enabled).toBe(false);
  expect(config.hooks.events).toEqual({
    SessionStart: [],
    UserPromptSubmit: [],
    PreToolUse: [],
    PermissionRequest: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    Stop: []
  });
  expect(config.model.mainThoughtLevel).toBe("max");
  expect(config.model.liteThoughtLevel).toBe("enabled");
  // model.available remains runtime-internal rather than a user-config key.
  expect(Object.keys(config.model).sort()).toEqual([
    "lite",
    "liteThoughtLevel",
    "main",
    "mainThoughtLevel"
  ]);
});
