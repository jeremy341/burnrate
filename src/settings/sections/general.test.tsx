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

import { section } from "./general";

const Component = section.Component;

function render(): string {
  return renderToStaticMarkup(<Component />);
}

beforeEach(() => {
  mocks.settings = structuredClone(DEFAULT_SETTINGS);
  mocks.updateSettings.mockClear();
  vi.stubGlobal("window", {});
});

afterEach(() => vi.unstubAllGlobals());

describe("Settings > General", () => {
  it("keeps only the settings needed to run the app", () => {
    const html = render();
    for (const label of ["Launch at login", "Start minimized", "Close to tray", "Language", "Time format"]) {
      expect(html, label).toContain(label);
    }
    // Removed sections: nothing here is hidden behind "advanced" or "not applied" notes.
    for (const removed of [
      "Hide sensitive details",
      "Check for updates",
      "Privacy",
      "Updates",
      "Burnrate is available in English",
      "Not applied yet",
    ]) {
      expect(html, removed).not.toContain(removed);
    }
  });

  it("uses T3's copy, spacing and control width", () => {
    const html = render();
    expect(html).toContain("Sets how dates and numbers are written. Interface text is English only.");
    expect(html).toContain("System default follows your browser or OS clock preference.");
    expect(html).toContain("flex flex-col gap-6");
    expect(html).toContain("sm:w-40");
    expect(html).not.toContain("sm:w-44");
  });

  it("offers the language and time-format options", () => {
    const html = render();
    expect(html).toContain('aria-label="Language"');
    expect(html).toContain('aria-label="Time format"');
    // Select popups are closed in static markup, so verify the selected label for each option.
    for (const format of ["12-hour", "24-hour"] as const) {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.general.timestampFormat = format;
      mocks.settings = settings;
      expect(render(), format).toContain(`>${format}</span>`);
    }
  });
});
