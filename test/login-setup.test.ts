import { describe, expect, test } from "bun:test";

import {
  classifySetupLoginCommand,
  decideSetupAfterLogin,
  isCodingPlanLoginPickerCommand,
  setupLoginFinishedWithoutAccessNotice
} from "../packages/zcode-tui/src/login-setup.ts";

describe("setup login command classification", () => {
  test("recognizes Coding Plan picker commands", () => {
    expect(isCodingPlanLoginPickerCommand("/login zai-coding-plan")).toBe(true);
    expect(isCodingPlanLoginPickerCommand("/login zai-coding-plan-api-key")).toBe(true);
    expect(isCodingPlanLoginPickerCommand("/login bigmodel-coding-plan")).toBe(true);
    expect(isCodingPlanLoginPickerCommand("/login")).toBe(false);
    expect(isCodingPlanLoginPickerCommand("/resume session")).toBe(false);
  });

  test("classifies OAuth and API-key methods", () => {
    expect(classifySetupLoginCommand("/login zai-coding-plan")).toBe("oauth");
    expect(classifySetupLoginCommand("/login zai-coding-plan-api-key secret")).toBe("api-key");
    expect(classifySetupLoginCommand("/login bigmodel-coding-plan")).toBe("other");
    expect(classifySetupLoginCommand("/login")).toBeNull();
  });
});

describe("first-run setup after /login", () => {
  test("completes only when configured model access exists", () => {
    expect(decideSetupAfterLogin({
      access: { model: "zai/glm-5.2" },
      interaction: { kind: "method-started", method: "oauth" },
      manual: false
    })).toEqual({ action: "complete", clearPending: true });

    expect(decideSetupAfterLogin({
      access: { model: "zai/glm-5.2" },
      interaction: { kind: "opened" },
      manual: false
    })).toEqual({ action: "complete", clearPending: true });
  });

  test("does not soft-pass when the session gate is already clear without access", () => {
    const decision = decideSetupAfterLogin({
      access: null,
      interaction: { kind: "method-started", method: "api-key" },
      manual: false
    });
    expect(decision.action).toBe("leave");
    expect(decision.clearPending).toBe(false);
    expect(decision.notice?.text).toBe(setupLoginFinishedWithoutAccessNotice);
  });

  test("breaks the auto Sign-in / /login loop after a completed login attempt", () => {
    for (const interaction of [
      { kind: "opened" } as const,
      { kind: "method-started", method: "oauth" } as const,
      { kind: "method-started", method: "api-key" } as const
    ]) {
      const decision = decideSetupAfterLogin({
        access: null,
        interaction,
        manual: false
      });
      expect(decision.action).toBe("leave");
      expect(decision.clearPending).toBe(false);
    }
  });

  test("returns to the method picker only when the user cancels /login", () => {
    expect(decideSetupAfterLogin({
      access: null,
      interaction: { kind: "picker-cancelled" },
      manual: false
    })).toEqual({ action: "retry-methods", clearPending: false });
  });

  test("leaves after custom-provider help so setup does not reopen Sign-in", () => {
    expect(decideSetupAfterLogin({
      access: null,
      interaction: { kind: "custom-help" },
      manual: false
    })).toEqual({ action: "leave", clearPending: true });
  });

  test("lets an explicit /setup retry methods after a failed attempt", () => {
    const decision = decideSetupAfterLogin({
      access: null,
      interaction: { kind: "method-started", method: "oauth" },
      manual: true
    });
    expect(decision.action).toBe("retry-methods");
    expect(decision.clearPending).toBe(false);
    expect(decision.notice?.text).toBe(setupLoginFinishedWithoutAccessNotice);
  });
});
