import { sanitizeTerminalText } from "./terminal-text.ts";

// Mirrors opencode's "OC | <first message>" terminal title so hosts (Orca,
// terminal emulators) show a content-derived label instead of the process name.
export const SESSION_TITLE_PREFIX = "ZC | ";

export const MAX_SESSION_TITLE_CHARS = 50;

export const SESSION_TITLE_SPINNER_FRAME_DURATION_MS = 120;

// Braille frames keep the title width stable while making an active turn visible.
const sessionTitleSpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function sessionTitleSpinnerFrame(elapsedMilliseconds: number, animated = true): string {
  if (!animated) return sessionTitleSpinnerFrames[0];
  const frame = Math.floor(Math.max(0, elapsedMilliseconds) / SESSION_TITLE_SPINNER_FRAME_DURATION_MS);
  return sessionTitleSpinnerFrames[frame % sessionTitleSpinnerFrames.length] ?? sessionTitleSpinnerFrames[0];
}

export function normalizeSessionTitle(title: string): string {
  return sanitizeTerminalText(title).replace(/\s+/gu, " ").trim();
}

export function sessionTitleFromFirstMessage(message: string): string | null {
  const normalized = normalizeSessionTitle(message);
  if (!normalized) {
    return null;
  }
  const characters = Array.from(normalized);
  if (characters.length <= MAX_SESSION_TITLE_CHARS) {
    return normalized;
  }
  return `${characters.slice(0, MAX_SESSION_TITLE_CHARS - 1).join("")}…`;
}

export function emitSessionTerminalTitle(
  stream: { isTTY?: boolean; write: (chunk: string) => void } | undefined,
  title: string
): void {
  if (!stream?.isTTY) return;
  // This is the final boundary for both user input and persisted runtime titles.
  const safeTitle = normalizeSessionTitle(title);
  // Empty title clears the terminal title, restoring the host's default label.
  stream.write(safeTitle ? `\x1b]0;${SESSION_TITLE_PREFIX}${safeTitle}\x07` : "\x1b]0;\x07");
}
