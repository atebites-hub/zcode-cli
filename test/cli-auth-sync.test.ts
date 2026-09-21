import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCliAuthFromDesktop } from "../src/cli-auth-sync.ts";
import { writeProviderFixture } from "./fixtures/provider-config.ts";

test("native Desktop access is recognized without copying credentials into CLI settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-native-auth-"));
  const env = { HOME: home, USERPROFILE: home };
  try {
    const { path } = await writeProviderFixture(env, { apiKey: "fixture-key" });
    const before = await readFile(path, "utf8");
    let resolved = false;
    expect(await syncCliAuthFromDesktop({ env, resolveApiKey: async () => { resolved = true; return "unexpected"; } }))
      .toEqual({ status: "already-configured", providerId: "custom" });
    expect(resolved).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await stat(join(home, ".zcode", "cli", "setting.json")).catch(() => null)).toBeNull();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("missing native configuration leaves authentication to native login", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-native-auth-"));
  try {
    expect(await syncCliAuthFromDesktop({ env: { HOME: home, USERPROFILE: home } }))
      .toEqual({ status: "unavailable", reason: "no-config" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
