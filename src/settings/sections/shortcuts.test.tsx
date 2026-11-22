import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type AppSettings } from "~/settings/schema";

const mocks = vi.hoisted(() => ({
  settings: undefined as AppSettings | undefined,
  updateSettings: vi.fn(),
}));

vi.mock("~/settings/store", () => ({
  useSettings: (selector: (settings: AppSettings) => unknown) =>
    selector(mocks.settings ?? DEFAULT_SETTINGS),
  updateSettings: mocks.updateSettings,
}));

import { section } from "./shortcuts";

const Component = section.Component;

function render(): string {
  return renderToStaticMarkup(<Component />);
}

beforeEach(() => {
  mocks.settings = structuredClone(DEFAULT_SETTINGS);
  mocks.updateSettings.mockClear();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe("Settings > Shortcuts", () => {
  it("renders a T3-style keybindings list with kbd chips", () => {
    const html = render();
    expect(html).toContain("Global shortcut");
    expect(html).toContain("Toggle main window");
    expect(html).toContain("Show or hide Burnrate from anywhere.");
    expect(html).toContain("Navigation");
    expect(html).toContain("Usage");
    for (const action of [
      "Open Settings",
      "Open command palette",
      "Show cost",
      "Show tokens",
      "Show limits",
      "Period: Past 24h",
    ]) {
      expect(html, action).toContain(action);
    }
    expect(html).toContain("data-slot=\"kbd-group\"");
  });

  it("has no walls of text, hover-only controls or pending-apply notes", () => {
    const html = render();
    for (const gone of [
      "Not applied yet",
      "always uses Ctrl+Shift+B",
      "Press a key combination. Escape cancels.",
      "Conflicts with",
      "Record a key combination to show or hide Burnrate.",
      "Needs the desktop app; browsers cannot register global shortcuts.",
      ">Save<",
      ">Apply<",
    ]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it("shows the current shortcut as a click-to-rebind control", () => {
    mocks.settings!.shell.globalShortcut = "Ctrl+Shift+B";
    const html = render();
    expect(html).toContain("Change shortcut, currently Ctrl+Shift+B");
    // The capture target only appears while recording; idle renders the kbd-chip pill.
    expect(html).not.toContain("data-keybinding-capture");
    expect(html).toContain("Remove shortcut");
    // The stored combo is rendered as individual key caps.
    expect(html).toContain(">B</kbd>");
  });

  it("does not repeat the section name in every usage row", () => {
    const html = render();
    expect(html).not.toContain("Usage: ");
  });

  it("surfaces a single, concise conflict warning when the binding is taken", () => {
    mocks.settings!.shell.globalShortcut = "mod+k";
    const html = render();
    expect(html).toContain("Also used by");
    expect(html).toContain("Open command palette");
    expect(html).not.toContain("Conflicts with your global shortcut");
  });
});
