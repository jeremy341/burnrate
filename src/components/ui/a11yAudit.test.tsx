import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LimitsAccount } from "~/contracts";
import { AppNavProvider, HeaderRefreshButton, ScreenHeader, type AppNav } from "../AppHeader";
import { LimitsErrorState } from "../usage/UsageLimitsStates";
import { LimitsSkeleton } from "../skeletons/LimitsSkeleton";
import { UsageLimitsPooled } from "../usage/UsageLimitsPooled";
import { UsageShareBar } from "../usage/UsageShareBar";
import { UsageProviderChart } from "../usage/UsageProviderChart";
import { AppMain, AppShell, SkipToContent, focusAppContent } from "./app-shell";
import { accessibleText, auditMarkup } from "./a11yAudit";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: React.ReactNode) => <div data-portal>{children}</div>,
}));

const Icon = ({ className }: { className?: string }) => <svg className={className} aria-hidden="true" />;
const NAV: AppNav = {
  view: "usage",
  screens: [
    { id: "usage", title: "Usage", icon: Icon },
    { id: "providers", title: "Providers", icon: Icon },
    { id: "settings", title: "Settings", icon: Icon },
  ],
  navigate: () => {},
  homeClose: true,
  close: () => {},
};
const NOW = Date.parse("2026-11-21T10:00:00.000Z");

function limitsAccount(): LimitsAccount {
  return {
    id: "claude-claude",
    driver: "claude",
    label: "Jerry",
    limits: {
      checkedAt: "2026-11-21T09:59:00.000Z",
      windows: [
        { id: "five_hour", kind: "session", label: "Session (5h)", usedPercent: 42, resetsAt: "2026-11-21T13:00:00.000Z" },
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 71, resetsAt: "2026-11-25T13:00:00.000Z" },
      ],
    },
  } as LimitsAccount;
}

describe("auditMarkup (the checker itself)", () => {
  it("flags unnamed controls, duplicate ids, dangling references, positive tabindex and missing alt", () => {
    const rules = auditMarkup(
      '<button><svg aria-hidden="true"></svg></button><i id="a"></i><i id="a"></i><div aria-labelledby="nope"></div><div tabindex="3"></div><img src="x">',
    ).map((violation) => violation.rule);
    expect(rules).toEqual(expect.arrayContaining(["accessible-name", "duplicate-id", "aria-ref", "tabindex", "image-alt"]));
  });

  it("accepts named controls and ignores aria-hidden subtrees when computing a name", () => {
    expect(auditMarkup('<button aria-label="Close"><svg aria-hidden="true"></svg></button>')).toEqual([]);
    expect(auditMarkup("<button>Save</button>")).toEqual([]);
    expect(accessibleText('<span aria-hidden="true">/</span>Usage')).toBe("Usage");
  });

  it("flags focusable content inside aria-hidden and meters without value text", () => {
    expect(auditMarkup('<div aria-hidden="true"><button>x</button></div>').map((v) => v.rule)).toContain("aria-hidden-focus");
    expect(auditMarkup('<div role="meter" aria-label="Weekly" aria-valuenow="4"></div>').map((v) => v.rule)).toContain("aria-value");
  });
});

describe("accessibility of rendered surfaces", () => {
  it("the window shell has a banner header, one named main, a skip link and a polite screen announcement", () => {
    const html = renderToStaticMarkup(
      <AppNavProvider value={NAV}>
        <AppShell>
          <ScreenHeader screenId="providers" title="Providers" />
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
          <AppMain label="Providers">
            <div data-app-content="" tabIndex={-1} />
          </AppMain>
        </AppShell>
      </AppNavProvider>,
    );
    expect(auditMarkup(html, { page: true })).toEqual([]);
    expect(html).toMatch(/^<div data-slot="app-shell"[^>]*><button[^>]*data-slot="skip-link"/);
    expect(html.indexOf("skip-link")).toBeLessThan(html.indexOf("<header"));
    expect(html).toContain('<main aria-label="Providers"');
    expect(html).not.toMatch(/<header[^>]*>[^]*<main[^>]*>[^]*<\/main>[^]*<\/header>/);
  });

  it("the skip link is hidden until focused and is a button (hash routing owns #)", () => {
    const html = renderToStaticMarkup(<SkipToContent />);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain("sr-only");
    expect(html).toContain("focus-visible:not-sr-only");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("Skip to content");
  });

  it("focusAppContent targets the visible screen only", () => {
    const focus = vi.fn();
    let selector = "";
    const root = {
      querySelector: (value: string) => {
        selector = value;
        return { focus } as unknown as HTMLElement;
      },
    };
    expect(focusAppContent(root as unknown as ParentNode)).toBe(true);
    expect(selector).toBe("[data-app-content]:not([inert])");
    expect(focusAppContent({ querySelector: () => null })).toBe(false);
  });

  it("the Usage header has no environment picker and names every control", () => {
    const html = renderToStaticMarkup(
      <AppNavProvider value={NAV}>
        <ScreenHeader screenId="usage" title="Usage" slots={{ provider: () => {}, actions: () => {} }} actions={<HeaderRefreshButton label="Refresh limits" busy={false} onClick={() => {}} />} />
      </AppNavProvider>,
    );
    expect(auditMarkup(html)).toEqual([]);
    expect(html).not.toMatch(/environment/i);
    expect(html).toContain('<header');
    expect(html).toContain('aria-label="Usage breadcrumb"');
  });

  it("limit meters are named, valued, and read with their context", () => {
    const html = renderToStaticMarkup(<UsageLimitsPooled accounts={[limitsAccount()]} notices={[]} now={NOW} />);
    expect(auditMarkup(html)).toEqual([]);
    expect(html).toMatch(/role="meter"/);
    expect(html).toMatch(/aria-valuetext="[^"]+"/);
  });

  it("limits error, loading and share-bar states carry text, not just colour", () => {
    const html = renderToStaticMarkup(
      <>
        <LimitsSkeleton />
        <LimitsErrorState error="Network down" onRetry={() => {}} />
        <UsageShareBar
          label="Tokens by type"
          format={(value) => String(value)}
          segments={[
            { label: "Input", value: 30, color: "#4a90d9" },
            { label: "Output", value: 70, color: "#d97b4a" },
          ]}
        />
      </>,
    );
    expect(auditMarkup(html)).toEqual([]);
    expect(html).toContain("30.0%");
    expect(html).toContain("70.0%");
  });

  it("the usage chart has a screen-reader table and keeps the hover-only plot out of the tree", () => {
    const totals = { totalTokens: 432, costUsd: 1 };
    const html = renderToStaticMarkup(
      <UsageProviderChart
        providers={["claude"]}
        days={["2026-11-20", "2026-11-21"]}
        daily={[
          { day: "2026-11-20", ...totals, byProvider: new Map([["claude", totals]]) },
          { day: "2026-11-21", ...totals, byProvider: new Map([["claude", totals]]) },
        ] as never}
        hours={[]}
        hourly={[]}
        metric="tokens"
        referenceTime={undefined}
        resolution="day"
        timeZone="UTC"
        hour12={false}
      />,
    );
    expect(auditMarkup(html)).toEqual([]);
    expect(html).toContain("<caption>");
    expect(html).toMatch(/<svg[^>]*aria-hidden/);
  });
});

// ---- Source-level rules: cheap guards that cannot rot into a stale snapshot ----

const SRC = join(__dirname, "..", "..");
const SCANNED = ["components/usage", "components/ui", "components/AppHeader.tsx", "App.tsx", "settings/layout.tsx", "settings/SettingsPage.tsx"];

function sourceFiles(path: string): string[] {
  const full = join(SRC, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((entry) => {
    const next = join(path, entry);
    if (statSync(join(SRC, next)).isDirectory()) return sourceFiles(next);
    return /\.tsx$/.test(entry) && !/\.test\./.test(entry) ? [join(SRC, next)] : [];
  });
}

const FILES = SCANNED.flatMap(sourceFiles).map((file) => ({ file: relative(SRC, file), text: readFileSync(file, "utf8") }));

describe("accessibility source rules", () => {
  it("never makes a non-interactive element clickable", () => {
    const offenders = FILES.filter(({ text }) => /<(div|span|li|p|td|tr)\b[^>]*\sonClick=/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("never uses a positive tabIndex", () => {
    const offenders = FILES.filter(({ text }) => /tabIndex=\{?["']?[1-9]/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("gives every icon-only Button an accessible name", () => {
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      for (const match of text.matchAll(/<Button\b((?:[^<>]|=>)*)>/g)) {
        const props = match[1] ?? "";
        // `render={<Button />}` is named by the component that renders it (Trigger, Close, ...), not here.
        if (text.slice(Math.max(0, match.index - 8), match.index).endsWith("render={")) continue;
        if (/size="icon[^"]*"/.test(props) && !/aria-label|aria-labelledby|\{\.\.\./.test(props)) {
          offenders.push(`${file}: ${match[0].slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("opens external windows with noopener", () => {
    const offenders = FILES.filter(({ text }) => /window\.open\([^)]*\)/.test(text) && /window\.open\([^)]*\)/.exec(text)![0].indexOf("noopener") === -1).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps the 'All environments' picker out of the product UI", () => {
    const offenders = FILES.filter(({ text }) => /All environments|Environment filter/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
