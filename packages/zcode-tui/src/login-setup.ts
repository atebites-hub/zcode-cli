/** Outcome of the in-wizard `/login` interaction. */
export type SetupLoginInteraction =
  | { kind: "opened" }
  | { kind: "picker-cancelled" }
  | { kind: "custom-help" }
  | { kind: "method-started"; method: "oauth" | "api-key" | "other" };

export type SetupAfterLoginAction = "complete" | "retry-methods" | "leave";

export interface SetupAfterLoginDecision {
  action: SetupAfterLoginAction;
  clearPending: boolean;
  notice?: { text: string; tone: "muted" | "warning" };
}

export interface SetupAfterLoginInput {
  access: { model: string } | null;
  interaction: SetupLoginInteraction;
  manual: boolean;
}

const codingPlanLoginPattern = /^\/login\s+(?:zai|bigmodel)-/u;
const apiKeyLoginPattern = /^\/login\s+(?:zai|bigmodel)-coding-plan-api-key(?:\s|$)/iu;

export const setupLoginFinishedWithoutAccessNotice =
  "Login did not produce model access · run /login or /setup to try again.";

export const setupSkippedNotice = "Setup skipped · run /login or /setup anytime.";

export function shouldDismissFirstRunSetup(input: {
  aborted?: boolean;
  skipRequested?: boolean;
  selectedValue?: string | null;
}): boolean {
  if (input.aborted === true || input.skipRequested === true) return true;
  return "selectedValue" in input
    && (input.selectedValue == null || input.selectedValue === "skip");
}

export function isCodingPlanLoginPickerCommand(command: string): boolean {
  return codingPlanLoginPattern.test(command);
}

export function classifySetupLoginCommand(
  command: string
): "oauth" | "api-key" | "other" | null {
  const trimmed = command.trim();
  if (trimmed === "/login zai-coding-plan") return "oauth";
  if (apiKeyLoginPattern.test(trimmed)) return "api-key";
  if (codingPlanLoginPattern.test(trimmed)) return "other";
  return null;
}

/**
 * Decide what the first-run / `/setup` wizard should do after `/login`.
 *
 * Credentials on disk are the only success signal (no soft-pass). A completed
 * `/login` that did not configure access must not bounce back to Sign-in —
 * that is the Linux TUI loop (Sign-in → `/login` → Sign-in).
 */
export function decideSetupAfterLogin(input: SetupAfterLoginInput): SetupAfterLoginDecision {
  if (input.access) {
    return { action: "complete", clearPending: true };
  }

  switch (input.interaction.kind) {
    case "picker-cancelled":
      return { action: "retry-methods", clearPending: false };
    case "custom-help":
      return { action: "leave", clearPending: true };
    case "opened":
    case "method-started":
      return {
        action: input.manual ? "retry-methods" : "leave",
        clearPending: false,
        notice: {
          text: setupLoginFinishedWithoutAccessNotice,
          tone: "muted"
        }
      };
    default: {
      const _exhaustive: never = input.interaction;
      return _exhaustive;
    }
  }
}
