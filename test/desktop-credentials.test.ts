import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decryptDesktopCredential,
  desktopCredentialSecret,
  desktopCredentialsPath,
  encryptDesktopCredential,
  readDesktopOAuthTokens
} from "../src/desktop-credentials.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-desktop-credentials-"));
  temporaryDirectories.push(home);
  return home;
}

describe("desktop credential cipher", () => {
  test("derives the official machine-bound fallback secret", () => {
    expect(desktopCredentialSecret({
      home: "/Users/zcode-test",
      platform: "darwin",
      username: "test-user"
    })).toBe("zcode-credential-fallback:darwin:/Users/zcode-test:test-user");
    expect(desktopCredentialSecret({
      home: "/home/alice",
      platform: "linux",
      username: "alice"
    })).toBe("zcode-credential-fallback:linux:/home/alice:alice");
  });

  test("prefers ZCODE_CREDENTIAL_SECRET when set", () => {
    expect(desktopCredentialSecret({
      env: { ZCODE_CREDENTIAL_SECRET: "override-secret" },
      home: "/home/alice",
      platform: "linux",
      username: "alice"
    })).toBe("override-secret");
  });

  test("decrypts the official enc:v1 fixture", () => {
    expect(decryptDesktopCredential(
      "enc:v1:AAECAwQFBgcICQoL.NTIF8rgqI66J7hvPIwTD8g.QTtgwDlfAEvz72ttQggYC2KZyVwLVA",
      {
        home: "/Users/zcode-test",
        platform: "darwin",
        username: "test-user"
      }
    )).toBe("official-fixture-token");
  });

  test("round-trips plaintext and Linux enc:v1 values", () => {
    const options = { home: "/home/alice", platform: "linux" as const, username: "alice" };
    expect(decryptDesktopCredential("plain-oauth-token", options)).toBe("plain-oauth-token");
    const encrypted = encryptDesktopCredential("linux-oauth-token", options);
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(decryptDesktopCredential(encrypted, options)).toBe("linux-oauth-token");
  });

  test("fails closed when the machine-bound key does not match", () => {
    const encrypted = encryptDesktopCredential("secret", {
      home: "/home/alice",
      platform: "linux",
      username: "alice"
    });
    expect(() => decryptDesktopCredential(encrypted, {
      home: "/home/alice",
      platform: "linux",
      username: "bob"
    })).toThrow(/decrypt/i);
  });
});

describe("desktop OAuth token reader", () => {
  test("resolves ~/.zcode/v2/credentials.json on Linux and Windows", () => {
    expect(desktopCredentialsPath({ HOME: "/home/alice" }, "linux", "/fallback"))
      .toBe("/home/alice/.zcode/v2/credentials.json");
    expect(desktopCredentialsPath({ USERPROFILE: "C:\\Users\\Alice" }, "win32", "C:\\fallback"))
      .toBe("C:\\Users\\Alice\\.zcode\\v2\\credentials.json");
  });

  test("reads encrypted zai tokens written by desktop login", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home, USER: "alice" };
    const options = { env, home, platform: "linux" as const, username: "alice" };
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(desktopCredentialsPath(env, "linux", home), JSON.stringify({
      "oauth:active_provider": encryptDesktopCredential("zai", options),
      "oauth:zai:access_token": encryptDesktopCredential("zai-access-token", options),
      "zcodejwttoken": encryptDesktopCredential("zcode-jwt", options),
      "oauth:zai:user_info": encryptDesktopCredential(JSON.stringify({ user_id: "user-1" }), options)
    }));

    expect(await readDesktopOAuthTokens({ env, platform: "linux", fallbackHome: home, username: "alice" }))
      .toEqual({
        provider: "zai",
        accessToken: "zai-access-token",
        jwtToken: "zcode-jwt",
        userInfo: { user_id: "user-1" }
      });
  });

  test("returns null when credentials are missing or undecryptable", async () => {
    const home = await temporaryHome();
    const env = { HOME: home, USERPROFILE: home, USER: "alice" };
    expect(await readDesktopOAuthTokens({ env, platform: "linux", fallbackHome: home })).toBeNull();

    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(desktopCredentialsPath(env, "linux", home), JSON.stringify({
      "oauth:zai:access_token": encryptDesktopCredential("hidden", {
        env,
        home,
        platform: "linux",
        username: "other-user"
      })
    }));
    expect(await readDesktopOAuthTokens({ env, platform: "linux", fallbackHome: home, username: "alice" }))
      .toBeNull();
  });
});
