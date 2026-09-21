import { allowlistedShellScenario } from "./allowlisted-shell.ts";
import { httpMockScenario } from "./http-mock.ts";
import { modelResumeScenario } from "./model-resume.ts";
import { permissionRequestQueueScenario } from "./permission-request-queue.ts";
import { sessionRenameScenario } from "./session-rename.ts";
import type { TuiScenario } from "./types.ts";
import { writeAndDiffScenario } from "./write-and-diff.ts";

const scenarios = new Map<string, TuiScenario>([
  [allowlistedShellScenario.name, allowlistedShellScenario],
  [httpMockScenario.name, httpMockScenario],
  [modelResumeScenario.name, modelResumeScenario],
  [permissionRequestQueueScenario.name, permissionRequestQueueScenario],
  [sessionRenameScenario.name, sessionRenameScenario],
  [writeAndDiffScenario.name, writeAndDiffScenario]
]);

export function listTuiScenarios(): TuiScenario[] {
  return [...scenarios.values()];
}

export function findTuiScenario(name: string): TuiScenario {
  const scenario = scenarios.get(name);
  if (!scenario) {
    throw new Error(`Unknown TUI scenario "${name}". Available: ${[...scenarios.keys()].join(", ")}`);
  }
  return scenario;
}
