import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  createPortableOAuthCallbackReceiver,
  type CommandRunner
} from "../src/portable-oauth-callback.ts";

const callbackUrl = "zcode://zai-auth/callback?code=loopback-code&state=expected-state";

describe("portable Z.AI OAuth callback receiver", () => {
  test("completes from a localhost HTTP capture of the registered zcode:// URL", async () => {
    const receiver = await createPortableOAuthCallbackReceiver({
      input: null,
      registerSchemeHandler: false,
      scheme: "zcode"
    });
    try {
      expect(receiver.captureOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const response = await fetch(`${receiver.captureOrigin}/capture`, {
        body: callbackUrl,
        headers: { "Content-Type": "text/plain" },
        method: "POST"
      });
      expect(response.ok).toBe(true);
      expect(await receiver.waitForCallback()).toBe(callbackUrl);
    } finally {
      await receiver.dispose();
    }
  });

  test("completes when the callback URL is pasted on stdin", async () => {
    const input = new PassThrough();
    const receiver = await createPortableOAuthCallbackReceiver({
      input,
      listen: false,
      registerSchemeHandler: false,
      scheme: "zcode"
    });
    try {
      const pending = receiver.waitForCallback();
      input.write(`  ${callbackUrl}  \n`);
      expect(await pending).toBe(callbackUrl);
    } finally {
      await receiver.dispose();
    }
  });

  test("registers and restores a Linux zcode:// handler that posts to localhost", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-portable-oauth-"));
    const calls: string[] = [];
    let currentHandler = "firefox.desktop";
    const runCommand: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "xdg-mime" && args[0] === "query") {
        return { code: 0, stderr: "", stdout: `${currentHandler}\n` };
      }
      if (command === "xdg-mime" && args[0] === "default") {
        currentHandler = args[1] ?? "";
        return { code: 0, stderr: "", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    try {
      const receiver = await createPortableOAuthCallbackReceiver({
        env: { HOME: home },
        input: null,
        registerSchemeHandler: true,
        runCommand,
        scheme: "zcode"
      });
      try {
        const desktopFiles = calls.filter((call) => call.includes("xdg-mime default"));
        expect(desktopFiles.some((call) => call.includes("x-scheme-handler/zcode"))).toBe(true);
        expect(currentHandler).toMatch(/zcode/i);
        const applications = join(home, ".local", "share", "applications");
        const names = await readdir(applications);
        const desktopName = names.find((name) => name.endsWith(".desktop"));
        expect(desktopName).toBeTruthy();
        const desktop = await readFile(join(applications, desktopName!), "utf8");
        expect(desktop).toContain("x-scheme-handler/zcode");
        const helperName = names.find((name) => name.endsWith(".sh"));
        expect(helperName).toBeTruthy();
        const helper = await readFile(join(applications, helperName!), "utf8");
        expect(helper).toContain(receiver.captureOrigin);
        const response = await fetch(`${receiver.captureOrigin}/capture`, {
          body: callbackUrl,
          method: "POST"
        });
        expect(response.ok).toBe(true);
        expect(await receiver.waitForCallback()).toBe(callbackUrl);
      } finally {
        await receiver.dispose();
      }
      expect(currentHandler).toBe("firefox.desktop");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
