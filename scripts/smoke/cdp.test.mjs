import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  anyTextPresentExpression,
  browserCandidates,
  clickAriaLabelExpression,
  dialogLabelExpression,
  openScreenMenuExpression,
  pickScreenExpression,
  clickGroupItemExpression,
  findBrowser,
  groupItemsExpression,
  pressedGroupItemExpression,
  textPresentExpression,
} from "./cdp.mjs";

describe("browser detection", () => {
  it("lists Edge and Chrome candidates on Windows", () => {
    const candidates = browserCandidates(
      {
        ProgramFiles: "C:/PF",
        "ProgramFiles(x86)": "C:/PF86",
        LOCALAPPDATA: "C:/Local",
      },
      "win32",
    );
    expect(candidates).toContain(
      path.join("C:/PF86", "Microsoft", "Edge", "Application", "msedge.exe"),
    );
    expect(candidates).toContain(path.join("C:/PF", "Google", "Chrome", "Application", "chrome.exe"));
  });

  it("puts SMOKE_BROWSER first and finds the first existing candidate", () => {
    const env = { SMOKE_BROWSER: "C:/custom/chrome.exe", ProgramFiles: "C:/PF" };
    expect(browserCandidates(env, "win32")[0]).toBe("C:/custom/chrome.exe");
    expect(
      findBrowser({
        env,
        platform: "win32",
        exists: (candidate) => candidate === "C:/custom/chrome.exe",
      }),
    ).toBe("C:/custom/chrome.exe");
    expect(findBrowser({ env: {}, platform: "win32", exists: () => false })).toBeNull();
  });
});

describe("page expressions", () => {
  it("escapes the group label and item text", () => {
    const expression = clickGroupItemExpression('Usage "metric"', "Cost");
    expect(expression).toContain('\\"metric\\"');
    expect(expression).toContain('"Cost"');
    expect(expression).toContain('data-slot="toggle"');
  });

  it("detects Base UI's data-pressed state", () => {
    expect(pressedGroupItemExpression("Usage metric")).toContain("data-pressed");
  });

  it("builds the screen switcher expressions", () => {
    expect(openScreenMenuExpression()).toContain('aria-label^="Go to"');
    expect(pickScreenExpression("Providers")).toContain("menuitemradio");
    expect(pickScreenExpression("Providers")).toContain('"Providers"');
    expect(dialogLabelExpression()).toContain("app-shell");
  });

  it("lists group items and clicks aria labels", () => {
    expect(groupItemsExpression("Usage metric")).toContain("data-slot");
    expect(clickAriaLabelExpression("Providers")).toContain("Providers");
    expect(textPresentExpression("Usage")).toContain("usage");
    expect(anyTextPresentExpression(["Cost", "Tokens"])).toContain('["cost","tokens"]');
  });
});
