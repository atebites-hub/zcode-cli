import { test } from "bun:test";
import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { sessionRenameScenario } from "./scenarios/session-rename.ts";

test("TUI safely persists and restores custom session titles", async () => {
  await runAutomatedTuiScenario(sessionRenameScenario);
}, 20_000);
