import {
  Box,
  Text
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

export const updateCommand = "Install the tested package from your fork release.";
export const releaseNotesUrl = "https://github.com/atebites-hub/zcode-cli/releases/latest";

export class UpdateAvailableView extends Box {
  constructor(theme: ZCodeTheme, currentVersion: string, latestVersion: string) {
    super(1, 0);
    const current = sanitizeTerminalText(currentVersion, { preserveSgr: false });
    const latest = sanitizeTerminalText(latestVersion, { preserveSgr: false });
    this.addChild(new Text([
      `${theme.accent("✨")} ${theme.bold("Update available!")} ${theme.muted(`${current} → ${latest}`)}`,
      theme.muted(updateCommand),
      `${theme.muted("Release notes:")} ${theme.accent(releaseNotesUrl)}`
    ].join("\n"), 0, 0));
  }
}
