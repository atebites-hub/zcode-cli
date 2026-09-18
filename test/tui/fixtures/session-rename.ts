#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { createScenarioRuntime, ScenarioRuntimeJournal } from "../runtime/scenario-runtime.ts";

let sessionId = "fixture-session";
const statePath = join(process.cwd(), ".session-title-state.json");
const journal = new ScenarioRuntimeJournal(process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL);
const transcript = () => sessionId === "new-session" ? [] : [
  { role: "user", content: sessionId === "fixture-session" ? "Original first prompt" : `First prompt: ${sessionId}` },
  { role: "agent", content: `Session ready: ${sessionId}` }
];
const readTitles = async (): Promise<Record<string, string>> => JSON.parse(await readFile(statePath, "utf8"));
const runtime = createScenarioRuntime({
  journal,
  unmatchedResponse: ({ input }) => `Echo: ${String(input)}`,
  turns: [{
    id: "resume",
    match: /^\/resume (fixture-session|other-session|unreadable-session|unsafe-session)$/u,
    steps: [{
      type: "respond",
      response: ({ input }) => {
        sessionId = String(input).slice("/resume ".length);
        return `Resumed ${sessionId}`;
      },
      metadata: () => ({ resetSessionProjection: true, restoredMessages: transcript() })
    }]
  }, {
    id: "clear",
    match: "/clear",
    steps: [{
      type: "respond",
      response: () => { sessionId = "new-session"; return "Started a new session"; },
      metadata: () => ({ resetSessionProjection: true, restoredMessages: [] })
    }]
  }]
});

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => transcript(),
  readSessionUsage: async () => ({ sessionId }),
  readCustomSessionTitle: async () => {
    if (sessionId === "unreadable-session") throw new Error("Metadata unavailable");
    return (await readTitles())[sessionId];
  },
  setCustomSessionTitle: async ({ title }) => {
    journal.record("session.rename", { sessionId, title });
    if (title === "fail rename") throw new Error("Store unavailable");
    await writeFile(statePath, JSON.stringify({ ...await readTitles(), [sessionId]: title }), "utf8");
  },
  submitPrompt: runtime.submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
});
