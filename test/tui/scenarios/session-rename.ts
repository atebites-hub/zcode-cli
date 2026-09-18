import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { TerminalSession } from "../harness/terminal-session.ts";
import type { TuiScenario } from "./types.ts";

export const sessionRenameScenario: TuiScenario = {
  name: "session-rename",
  description: "Renames sessions safely and restores their custom terminal titles after resume and restart.",
  fixture: join(import.meta.dir, "..", "fixtures", "session-rename.ts"),
  files: {
    ".session-title-state.json": JSON.stringify({ "unsafe-session": "Saved\u009c\u009d0;INJECTED\u009c" })
  },
  async run(session, workspace) {
    const storedTitle = async () => {
      const titles = JSON.parse(await readFile(join(workspace.directory, ".session-title-state.json"), "utf8"));
      return titles["fixture-session"];
    };
    await session.waitForScreen("initial transcript", /Session ready: fixture-session/u);
    await session.waitForTitle("first-message fallback", "ZC | Original first prompt");
    await session.sendAndWait("/rename\r", "rename usage", /Usage: \/rename <new title>/u);
    if (await storedTitle() !== undefined) throw new Error("Bare /rename changed the persisted title");

    await session.sendAndWait(
      "\x1b[200~/rename safe\u009c\u009d0;INJECTED\u009c\x1b[201~\r",
      "safe rename",
      /Session renamed to: safe/u
    );
    await session.waitForTitle("control sequences removed", "ZC | safe");
    if (await storedTitle() !== "safe") throw new Error("Control sequences reached the session store");

    await session.sendAndWait("/rename Chosen title\r", "custom rename", /Session renamed to: Chosen title/u);
    await session.waitForTitle("custom title", "ZC | Chosen title");
    await session.sendAndWait("/rename fail rename\r", "failed rename", /Rename failed: Store unavailable/u);
    await session.waitForTitle("title preserved on failure", "ZC | Chosen title");
    if (await storedTitle() !== "Chosen title") throw new Error("Failed rename changed the persisted title");

    for (const [id, title] of [
      ["other-session", "First prompt: other-session"],
      ["fixture-session", "Chosen title"],
      ["unreadable-session", "First prompt: unreadable-session"],
      ["unsafe-session", "Saved"],
      ["fixture-session", "Chosen title"]
    ]) {
      const start = session.historyCheckpoint();
      session.send(`/resume ${id}\r`);
      await session.waitForHistory(`resume ${id}`, new RegExp(`Resumed ${id}`, "u"), start);
      await session.waitForTitle(`restored title for ${id}`, `ZC | ${title}`);
    }
    await session.exit();

    await using restarted = TerminalSession.start({
      command: [process.execPath, sessionRenameScenario.fixture],
      workspace
    });
    await restarted.waitForScreen("restarted transcript", /Session ready: fixture-session/u);
    await restarted.waitForTitle("custom title survives restart", "ZC | Chosen title");
    await restarted.sendAndWait("/clear\r", "new session", /Started a new session/u);
    await restarted.waitForTitle("custom title cleared with session", "");
    await restarted.sendAndWait("after clear\r", "new prompt", /Echo: after clear/u);
    await restarted.waitForTitle("new session uses its own first message", "ZC | after clear");
    await restarted.exit();
  }
};
