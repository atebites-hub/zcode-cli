import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { captureCommand, type CommandResult } from "./command.ts";

const defaultTimeoutMs = 5 * 60_000;
const managedDesktopPrefix = "dev.zcode.cli.oauth-callback.";

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface OAuthCallbackReceiver {
  dispose(): Promise<void>;
  waitForCallback(signal?: AbortSignal, timeoutMs?: number): Promise<string>;
}

export interface PortableOAuthCallbackReceiver extends OAuthCallbackReceiver {
  captureOrigin: string;
}

export interface PortableOAuthCallbackOptions {
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream | null;
  listen?: boolean;
  registerSchemeHandler?: boolean;
  runCommand?: CommandRunner;
  scheme: string;
}

interface SchemeHandlerState {
  applicationsDirectory: string;
  desktopId: string;
  previousHandler: string;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Login cancelled.");
}

function linkSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(abortReason(signal));
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isZcodeCallbackUrl(value: string): boolean {
  return value.startsWith("zcode://");
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

async function readLine(
  input: NodeJS.ReadableStream,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw abortReason(signal);
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error: Error | undefined, line?: string) => {
      if (settled) return;
      settled = true;
      input.off("readable", onReadable);
      input.off("end", onEnd);
      input.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(line ?? "");
    };
    const onAbort = () => finish(abortReason(signal!));
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(undefined, buffer.replace(/\r$/u, ""));
    const onReadable = () => {
      for (;;) {
        const chunk = input.read();
        if (chunk == null) break;
        buffer += String(chunk);
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          finish(undefined, buffer.slice(0, newline).replace(/\r$/u, ""));
          return;
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    input.on("readable", onReadable);
    input.once("end", onEnd);
    input.once("error", onError);
    onReadable();
  });
}

async function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[]
): Promise<string> {
  const result = await runner(command, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited with status ${result.code}`);
  }
  return result.stdout.trim();
}

async function removeManagedDesktopFiles(applicationsDirectory: string): Promise<void> {
  const names = await readdir(applicationsDirectory).catch(() => []);
  await Promise.all(names
    .filter((name) => name.startsWith(managedDesktopPrefix))
    .map((name) => rm(join(applicationsDirectory, name), { force: true })));
}

async function registerLinuxSchemeHandler(
  options: PortableOAuthCallbackOptions,
  captureOrigin: string,
  callbackPath: string,
  runner: CommandRunner
): Promise<SchemeHandlerState | undefined> {
  if (!/^[a-z][a-z0-9+.-]*$/u.test(options.scheme)) {
    throw new Error(`Invalid callback scheme: ${options.scheme}`);
  }
  const home = options.env?.HOME || homedir();
  const applicationsDirectory = join(home, ".local", "share", "applications");
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const desktopId = `${managedDesktopPrefix}${nonce}.desktop`;
  const helperPath = join(applicationsDirectory, `${managedDesktopPrefix}${nonce}.sh`);
  const desktopPath = join(applicationsDirectory, desktopId);
  let previousHandler = "";

  try {
    previousHandler = await runChecked(runner, "xdg-mime", [
      "query",
      "default",
      `x-scheme-handler/${options.scheme}`
    ]).catch(() => "");
    await mkdir(applicationsDirectory, { recursive: true });
    await removeManagedDesktopFiles(applicationsDirectory);
    await writeFile(
      helperPath,
      [
        "#!/bin/sh",
        "url=\"$1\"",
        `printf '%s\\n' "$url" > ${JSON.stringify(callbackPath)}`,
        "if command -v curl >/dev/null 2>&1; then",
        `  curl -fsS --data-binary "$url" ${JSON.stringify(`${captureOrigin}/capture`)} >/dev/null 2>&1 || true`,
        "fi",
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    await chmod(helperPath, 0o700);
    await writeFile(
      desktopPath,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=ZCode CLI OAuth Callback",
        "NoDisplay=true",
        "StartupNotify=false",
        `MimeType=x-scheme-handler/${options.scheme};`,
        `Exec=/bin/sh ${JSON.stringify(helperPath)} %u`,
        ""
      ].join("\n"),
      { mode: 0o644 }
    );
    await runner("update-desktop-database", [applicationsDirectory]).catch(() => ({
      code: 1,
      stderr: "",
      stdout: ""
    }));
    await runChecked(runner, "xdg-mime", [
      "default",
      desktopId,
      `x-scheme-handler/${options.scheme}`
    ]);
    await runner("xdg-settings", [
      "set",
      "default-url-scheme-handler",
      options.scheme,
      desktopId
    ]).catch(() => ({ code: 1, stderr: "", stdout: "" }));
    return { applicationsDirectory, desktopId, previousHandler };
  } catch {
    await rm(helperPath, { force: true });
    await rm(desktopPath, { force: true });
    return undefined;
  }
}

async function restoreLinuxSchemeHandler(
  state: SchemeHandlerState,
  scheme: string,
  runner: CommandRunner
): Promise<void> {
  if (state.previousHandler) {
    await runner("xdg-mime", [
      "default",
      state.previousHandler,
      `x-scheme-handler/${scheme}`
    ]).catch(() => ({ code: 1, stderr: "", stdout: "" }));
  }
  await removeManagedDesktopFiles(state.applicationsDirectory);
  await runner("update-desktop-database", [state.applicationsDirectory]).catch(() => ({
    code: 1,
    stderr: "",
    stdout: ""
  }));
}

export async function createPortableOAuthCallbackReceiver(
  options: PortableOAuthCallbackOptions
): Promise<PortableOAuthCallbackReceiver> {
  const listen = options.listen !== false;
  const runner = options.runCommand ?? captureCommand;
  const lifetime = new AbortController();
  const callbackDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-oauth-"));
  const callbackPath = join(callbackDirectory, "callback.url");
  let accepted: string | undefined;
  let settle!: (url: string) => void;
  const captured = new Promise<string>((resolve) => {
    settle = resolve;
  });
  const accept = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed || accepted) return false;
    accepted = trimmed;
    settle(trimmed);
    return true;
  };

  let server: Server | undefined;
  let captureOrigin = "";
  let handler: SchemeHandlerState | undefined;
  let disposePromise: Promise<void> | undefined;

  const handleCapture = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/capture") {
        sendHtml(response, 404, "<!doctype html><title>ZCode</title><p>Not found.</p>");
        return;
      }
      const posted = request.method === "POST" ? await readRequestBody(request) : "";
      const candidate = posted.trim() || url.searchParams.get("url") || url.searchParams.get("callback") || "";
      if (!isZcodeCallbackUrl(candidate) || !accept(candidate)) {
        sendHtml(response, 400, "<!doctype html><title>ZCode</title><p>Invalid OAuth callback.</p>");
        return;
      }
      sendHtml(
        response,
        200,
        "<!doctype html><title>ZCode</title><p>Authorization received. You can close this tab.</p>"
      );
    } catch {
      sendHtml(response, 500, "<!doctype html><title>ZCode</title><p>Callback failed.</p>");
    }
  };

  if (listen) {
    server = createServer((request, response) => {
      void handleCapture(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Unable to start the local OAuth callback listener.");
    }
    captureOrigin = `http://127.0.0.1:${address.port}`;
  }

  if (options.registerSchemeHandler && captureOrigin) {
    handler = await registerLinuxSchemeHandler(options, captureOrigin, callbackPath, runner);
  }

  const cleanup = async (): Promise<void> => {
    if (!lifetime.signal.aborted) lifetime.abort();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (handler) {
      await restoreLinuxSchemeHandler(handler, options.scheme, runner);
      handler = undefined;
    }
    await rm(callbackDirectory, { recursive: true, force: true });
  };

  return {
    captureOrigin,
    dispose() {
      return disposePromise ??= cleanup();
    },
    async waitForCallback(signal, timeoutMs = defaultTimeoutMs) {
      const abortSignal = linkSignals(signal, lifetime.signal);
      if (accepted) return accepted;
      const stdin = options.input
        ? (async () => {
          while (!abortSignal.aborted) {
            const line = await readLine(options.input!, abortSignal);
            if (line.trim() && accept(line)) return accepted!;
          }
          throw abortReason(abortSignal);
        })()
        : new Promise<string>((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortReason(abortSignal)), { once: true });
        });
      const filePoll = (async () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (abortSignal.aborted) throw abortReason(abortSignal);
          if (accepted) return accepted;
          const contents = await readFile(callbackPath, "utf8").catch(() => "");
          if (contents.trim() && accept(contents)) return accepted!;
          await delay(100, abortSignal);
        }
        throw new Error(
          "Authorization timed out. Please retry `zcode login` and paste the zcode:// callback URL."
        );
      })();
      const timeout = delay(timeoutMs, abortSignal).then(() => {
        throw new Error(
          "Authorization timed out. Please retry `zcode login` and paste the zcode:// callback URL."
        );
      });
      const racers = [captured, stdin, filePoll, timeout];
      for (const racer of racers) void racer.catch(() => {});
      return await Promise.race(racers);
    }
  };
}
