import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
  browserOpenCommand,
  buildZaiAuthorizeUrl,
  parseZaiOAuthCallback,
  parseZaiOAuthCallbackInput,
  runZaiOAuthLogin
} from "../src/zai-oauth.ts";

describe("Z.AI Desktop OAuth bridge", () => {
  test("builds the registered Desktop authorization request", () => {
    const url = new URL(buildZaiAuthorizeUrl("expected-state"));
    expect(`${url.origin}${url.pathname}`).toBe("https://chat.z.ai/api/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(url.searchParams.get("redirect_uri")).toBe("zcode://zai-auth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("expected-state");
  });

  test("accepts only the registered callback with the expected state", () => {
    const callback = "zcode://zai-auth/callback?code=authorization-code&state=expected-state";
    expect(parseZaiOAuthCallback(callback, "expected-state")).toEqual({
      callbackUrl: callback,
      code: "authorization-code",
      state: "expected-state"
    });
    expect(() => parseZaiOAuthCallback(
      "zcode://zai-auth/callback?code=authorization-code&state=wrong",
      "expected-state"
    )).toThrow(/state did not match/);
    expect(() => parseZaiOAuthCallback(
      "http://127.0.0.1/callback?code=authorization-code&state=expected-state",
      "expected-state"
    )).toThrow(/unexpected OAuth callback target/);
    expect(() => parseZaiOAuthCallback(
      "zcode://zai-auth/callback?error=access_denied&state=expected-state",
      "expected-state"
    )).toThrow(/access_denied/);
    expect(() => parseZaiOAuthCallback(
      "zcode://zai-auth/callback?error=forged-error&state=wrong",
      "expected-state"
    )).toThrow(/state did not match/);
  });

  test("restores the protocol receiver before handing the callback to the official runtime", async () => {
    const events: string[] = [];
    let output = "";
    const callbackUrl = "zcode://zai-auth/callback?code=private-code&state=expected-state";
    const code = await runZaiOAuthLogin({
      completeLogin: async (payload, runtimeArgs) => {
        events.push("complete");
        expect(events).toEqual(["open", "wait", "dispose", "complete"]);
        expect(payload).toEqual({ callbackUrl, state: "expected-state" });
        expect(runtimeArgs).toEqual(["login"]);
        return 0;
      },
      createReceiver: async ({ scheme }) => {
        expect(scheme).toBe("zcode");
        return {
          async dispose() {
            events.push("dispose");
          },
          async waitForCallback() {
            events.push("wait");
            return callbackUrl;
          }
        };
      },
      invocation: { json: false, noBrowser: false, runtimeArgs: ["login"] },
      openBrowser: async () => {
        events.push("open");
        return { opened: true };
      },
      output: { write(value) { output += value; } },
      platform: "darwin",
      state: "expected-state"
    });

    expect(code).toBe(0);
    expect(output).toContain("Opening browser for Z.AI authorization");
    expect(output).toContain("Authorization received");
    expect(output).not.toContain("private-code");
    expect(events.filter((event) => event === "dispose")).toHaveLength(1);
  });

  test("supports manual browser opening without invoking the opener", async () => {
    const callbackUrl = "zcode://zai-auth/callback?code=code&state=expected-state";
    let output = "";
    const code = await runZaiOAuthLogin({
      completeLogin: async () => 0,
      createReceiver: async () => ({
        async dispose() {},
        async waitForCallback() { return callbackUrl; }
      }),
      invocation: {
        json: false,
        noBrowser: true,
        runtimeArgs: ["login", "--no-browser"]
      },
      openBrowser: async () => {
        throw new Error("browser opener should not run");
      },
      output: { write(value) { output += value; } },
      platform: "darwin",
      state: "expected-state"
    });

    expect(code).toBe(0);
    expect(output).toContain("Open this URL to sign in");
  });

  test("extracts a pasted zcode:// callback or authorization code", () => {
    const callback = "zcode://zai-auth/callback?code=authorization-code&state=expected-state";
    expect(parseZaiOAuthCallbackInput(callback, "expected-state")).toEqual({
      callbackUrl: callback,
      code: "authorization-code",
      state: "expected-state"
    });
    expect(parseZaiOAuthCallbackInput(
      `Please open ${callback} to continue`,
      "expected-state"
    )).toEqual({
      callbackUrl: callback,
      code: "authorization-code",
      state: "expected-state"
    });
    expect(parseZaiOAuthCallbackInput("code-d305b6b2ad8d", "expected-state")).toEqual({
      callbackUrl: "zcode://zai-auth/callback?code=code-d305b6b2ad8d&state=expected-state",
      code: "code-d305b6b2ad8d",
      state: "expected-state"
    });
    expect(() => parseZaiOAuthCallbackInput(
      "http://127.0.0.1:9999/callback?code=authorization-code&state=expected-state",
      "expected-state"
    )).toThrow(/unexpected OAuth callback target/);
  });

  test("opens the authorize URL with the platform browser command", () => {
    const url = "https://chat.z.ai/api/oauth/authorize?state=expected-state";
    expect(browserOpenCommand("darwin", url)).toEqual({ command: "/usr/bin/open", args: [url] });
    expect(browserOpenCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
    expect(browserOpenCommand("win32", url)).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", url]
    });
  });

  test("completes Linux --no-browser login when the registered callback is pasted", async () => {
    const callbackUrl = "zcode://zai-auth/callback?code=linux-code&state=expected-state";
    const input = new PassThrough();
    let output = "";
    const login = runZaiOAuthLogin({
      completeLogin: async (payload, runtimeArgs) => {
        expect(payload).toEqual({ callbackUrl, state: "expected-state" });
        expect(runtimeArgs).toEqual(["login", "--no-browser"]);
        return 0;
      },
      input,
      invocation: {
        json: false,
        noBrowser: true,
        runtimeArgs: ["login", "--no-browser"]
      },
      openBrowser: async () => {
        throw new Error("browser opener should not run");
      },
      output: { write(value) { output += value; } },
      platform: "linux",
      registerSchemeHandler: false,
      state: "expected-state"
    });

    await waitForOutput(input, () => output.includes("Open this URL to sign in"));
    input.write(`${callbackUrl}\n`);

    expect(await login).toBe(0);
    expect(output).toContain("https://chat.z.ai/api/oauth/authorize");
    expect(output).toContain("Authorization received");
    expect(output).not.toContain("requires macOS");
    expect(output).not.toContain("linux-code");
    expect(output).toContain("paste");
  });
});

async function waitForOutput(
  stream: PassThrough,
  ready: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const startedAt = Date.now();
  while (!ready()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for login output.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (stream.writableNeedDrain) await new Promise((resolve) => stream.once("drain", resolve));
  }
}
