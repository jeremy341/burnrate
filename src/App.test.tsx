import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, readSettingsSectionName } from "./App";

const state = vi.hoisted(() => ({
  providersLoading: false,
  limitsLoading: false,
  reloadProviders: vi.fn(),
  refreshLimits: vi.fn(),
  pressRefresh: null as (() => void) | null,
}));

vi.mock("~/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api")>()),
  useLimits: () => ({ data: null, error: null, loading: state.limitsLoading, reload: () => {} }),
  useProviders: () => ({ data: null, error: null, loading: state.providersLoading, reload: state.reloadProviders }),
}));

vi.mock("~/state/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/usage")>()),
  useLimitsPolling: () => ({ refresh: state.refreshLimits, onLimitsEnter: () => {} }),
  useMinuteNow: () => 0,
}));

// Keep the real button and remember what a press would do, since static markup cannot click.
vi.mock("~/components/AppHeader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/AppHeader")>();
  return {
    ...actual,
    HeaderRefreshButton: (props: ComponentProps<typeof actual.HeaderRefreshButton>) => {
      state.pressRefresh = props.onClick;
      return <actual.HeaderRefreshButton {...props} />;
    },
  };
});

vi.mock("~/components/usage/UsagePage", () => ({ UsagePage: () => null }));

function root(textContent: string | null | undefined) {
  return {
    querySelector: (selector: string) =>
      selector.includes("data-settings-section") && textContent !== undefined
        ? ({ textContent } as Element)
        : null,
  };
}

describe("readSettingsSectionName", () => {
  it("reads the open Settings section from the page's own navigation", () => {
    expect(readSettingsSectionName(root("  Appearance "))).toBe("Appearance");
  });

  it("is null when no section is open, the label is blank, or there is no root", () => {
    expect(readSettingsSectionName(root(undefined))).toBeNull();
    expect(readSettingsSectionName(root("   "))).toBeNull();
    expect(readSettingsSectionName(null)).toBeNull();
  });
});

describe("the header refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    state.providersLoading = false;
    state.limitsLoading = false;
    state.pressRefresh = null;
    vi.clearAllMocks();
  });

  function renderAt(hash: string): string {
    vi.stubGlobal("window", { location: { hash }, addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("document", {
      title: "",
      documentElement: { dataset: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
    });
    return renderToStaticMarkup(<App />);
  }

  const buttonTag = (html: string, label: string) =>
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

  it("re-reads the provider list on Providers, and is named for that", () => {
    const html = renderAt("#providers");
    expect(html).toContain('aria-label="Refresh providers"');
    expect(html).not.toContain('aria-label="Refresh limits"');
  });

  it("is busy while the provider list or the limits behind its rows load", () => {
    expect(buttonTag(renderAt("#providers"), "Refresh providers")).toContain('aria-busy="false"');
    state.limitsLoading = true;
    expect(buttonTag(renderAt("#providers"), "Refresh providers")).toContain('aria-busy="true"');
    state.limitsLoading = false;
    state.providersLoading = true;
    expect(buttonTag(renderAt("#providers"), "Refresh providers")).toContain('aria-busy="true"');
  });

  it("re-reads both the provider list and the limits on one press", () => {
    renderAt("#providers");
    expect(state.pressRefresh).not.toBeNull();
    state.pressRefresh?.();
    expect(state.reloadProviders).toHaveBeenCalledTimes(1);
    expect(state.refreshLimits).toHaveBeenCalledTimes(1);
  });

  it("gives Usage and Settings no header refresh from the shell", () => {
    for (const hash of ["#usage", "#settings"]) {
      const html = renderAt(hash);
      expect(html).not.toContain('aria-label="Refresh providers"');
      expect(html).not.toContain('aria-label="Refresh limits"');
    }
  });
});
