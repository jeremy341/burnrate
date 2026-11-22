import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppHeader,
  AppHeaderClose,
  AppHeaderEnd,
  AppNavProvider,
  HeaderPicker,
  HeaderRefreshButton,
  HeaderSettingsButton,
  ScreenHeader,
  UsageHeaderPortal,
  UsageHeaderSlotsProvider,
  type AppNav,
  type UsageHeaderSlotRefs,
} from "./AppHeader";
import { PAGE_RHYTHM } from "./WorkspacePageContainer";

// Server rendering cannot mount a real portal, so stand in a marker element that names its target.
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: React.ReactNode, target: { id?: string }) => (
    <div data-portal={target.id}>{children}</div>
  ),
}));

const Icon = ({ className }: { className?: string }) => <svg className={className} />;
const NAV: AppNav = {
  view: "providers",
  screens: [
    { id: "usage", title: "Usage", icon: Icon, hint: "G U" },
    { id: "providers", title: "Providers", icon: Icon, hint: "G P" },
    { id: "settings", title: "Settings", icon: Icon, hint: "Ctrl ," },
  ],
  navigate: () => {},
  homeClose: false,
  close: () => {},
};
const NOOP_SLOTS: UsageHeaderSlotRefs = { provider: () => {}, actions: () => {} };

function render(nav: AppNav, node: React.ReactNode) {
  return renderToStaticMarkup(<AppNavProvider value={nav}>{node}</AppNavProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe("ScreenHeader (secondary screens)", () => {
  it("keeps a named command palette entry alongside Settings on every screen", () => {
    const html = render(NAV, <ScreenHeader screenId="providers" title="Providers" />);
    expect(html).toMatch(/<button[^>]*aria-label="Command palette"[^>]*aria-keyshortcuts="Control\+K Meta\+K"/);
    expect(html).toContain('aria-label="Providers, switch screen"');
    // The gear is the first control on the LEFT; the palette entry stays with the right-hand actions.
    expect(html.indexOf('aria-label="Settings"')).toBeLessThan(html.indexOf('aria-label="Command palette"'));
  });

  it("is one header row: the switcher carries the current screen title as its heading, then actions and close", () => {
    const html = render(NAV, <ScreenHeader screenId="providers" title="Providers" actions={<b id="act" />} />);
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain("min-h-(--workspace-topbar-height)");
    expect(html).toContain("border-b");
    expect(html).not.toContain("data-tauri-drag-region");
    expect(html).toContain("Providers breadcrumb");
    // The trigger shows the CURRENT screen ("Providers v") and the title is never a second crumb.
    expect(html).toMatch(/<h1[^>]*>[^]*aria-label="Providers, switch screen"[^]*>Providers<[^]*<\/h1>/);
    expect(html.match(/>Providers</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Providers, switch screen"');
    expect(html).toContain('id="act"');
    expect(html).toContain('aria-label="Back to Usage"');
    expect(html.indexOf('id="act"')).toBeLessThan(html.indexOf('aria-label="Back to Usage"'));
  });

  it("shows the current screen in the switcher and the section as the only extra segment", () => {
    const html = render(
      { ...NAV, view: "settings" },
      <ScreenHeader screenId="settings" title="Settings" section="Appearance" />,
    );
    expect(html).toContain('aria-label="Settings, switch screen"');
    expect(html).toContain('>Settings<');
    expect(html).toContain("Appearance");
    // One current breadcrumb segment (the section; the gear carries its own aria-current, checked below).
    expect(html.match(/<li[^>]*aria-current="page"/g)).toHaveLength(1);
  });

  it("draws the page's own title in the foreground and a title in front of a picker or section as quiet context", () => {
    const trigger = (html: string, name: string) =>
      html.match(new RegExp(`<button[^>]*aria-label="${name}, switch screen"[^>]*>`))?.[0] ?? "";
    const alone = render(NAV, <ScreenHeader screenId="providers" title="Providers" />);
    expect(trigger(alone, "Providers")).toMatch(/\stext-foreground\s/);
    expect(trigger(alone, "Providers")).not.toMatch(/\stext-muted-foreground\s/);
    const withSection = render(
      { ...NAV, view: "settings" },
      <ScreenHeader screenId="settings" title="Settings" section="Appearance" />,
    );
    expect(trigger(withSection, "Settings")).toMatch(/\stext-muted-foreground\s/);
    const usage = render(
      { ...NAV, view: "usage", homeClose: true },
      <ScreenHeader screenId="usage" title="Usage" slots={NOOP_SLOTS} />,
    );
    expect(trigger(usage, "Usage")).toMatch(/\stext-muted-foreground\s/);
  });

  it("keeps the screen switcher a 44px touch target on touch screens", () => {
    const html = render(NAV, <ScreenHeader screenId="providers" title="Providers" />);
    const switcher = html.match(/<button[^>]*aria-label="Providers, switch screen"[^>]*>/)?.[0] ?? "";
    expect(switcher).toContain("pointer-coarse:min-h-11");
  });

  it("keeps the screen actions ahead of search and close in tab order", () => {
    const html = render(NAV, <ScreenHeader screenId="providers" title="Providers" actions={<b id="act" />} />);
    expect(html.indexOf('id="act"')).toBeLessThan(html.indexOf('aria-label="Command palette"'));
    expect(html.indexOf('aria-label="Command palette"')).toBeLessThan(html.indexOf('aria-label="Back to Usage"'));
  });

  it("keeps a screen without a toolbar on one row: its actions sit with search and close", () => {
    const html = render(NAV, <ScreenHeader screenId="providers" title="Providers" actions={<b id="act" />} />);
    expect(html).not.toContain("header-toolbar");
    expect(html).not.toContain("@4xl/usage-header:grid-cols-");
    expect(html).toMatch(/class="col-start-3 row-start-1 [^"]*"[^>]*><b id="act"/);
    expect(html.indexOf('id="act"')).toBeLessThan(html.indexOf('aria-label="Command palette"'));
  });
});

describe("ScreenHeader on Usage (T3 topbar)", () => {
  const usage = () => render({ ...NAV, view: "usage", homeClose: true }, <ScreenHeader screenId="usage" title="Usage" slots={NOOP_SLOTS} />);

  it("is a breadcrumb `Usage / provider` (no environment picker) followed by an actions slot, then the close X", () => {
    const html = usage();
    expect(html).toContain("Usage breadcrumb");
    expect(html).toContain('aria-label="Usage, switch screen"');
    // One empty provider slot (hidden until the page fills it) and one actions slot.
    expect(html.match(/<li[^>]*empty:hidden[^>]*><\/li>/g)).toHaveLength(1);
    expect(html).not.toMatch(/environment/i);
    expect(html).toMatch(/<div[^>]*empty:hidden[^>]*><\/div>/);
    expect(html.indexOf("Usage breadcrumb")).toBeLessThan(html.indexOf('aria-label="Close"'));
  });

  it("is the full-width border-only bar: no card, no rounded corner, no shadow", () => {
    const html = usage();
    const header = html.match(/<header[^>]*>/)?.[0] ?? "";
    expect(header).toContain("border-b");
    expect(header).toContain("min-h-(--workspace-topbar-height)");
    expect(header).not.toMatch(/rounded|shadow|bg-card|\bborder\b(?!-)/);
    expect(html).not.toContain("<nav aria-label=\"Screens\"");
  });

  it("wraps Usage's toolbar onto its own row on a narrow bar, and never scrolls it sideways", () => {
    const html = usage();
    expect(html).not.toContain("overflow-x-auto");
    const toolbar = html.match(/<div[^>]*data-slot="header-toolbar"[^>]*>/)?.[0] ?? "";
    // Below @4xl the toolbar is a row of its own across the bar, and wraps if it must; from @4xl it is a column of the one row.
    expect(toolbar).toContain("col-span-full row-start-2");
    expect(toolbar).toContain("flex-wrap");
    expect(toolbar).toContain("@4xl/usage-header:col-start-3 @4xl/usage-header:row-start-1");
    // Search and close stay on the first row at every width, and follow the toolbar in the DOM.
    expect(html).toMatch(/class="col-start-3 row-start-1 [^"]*@4xl\/usage-header:col-start-4"/);
    expect(html.indexOf("header-toolbar")).toBeLessThan(html.indexOf('aria-label="Command palette"'));
  });

  it("keeps Settings one click away two ways: the Usage breadcrumb menu and a visible gear", () => {
    // The menu popup is closed in static markup; its trigger carries the name and the screens exist in nav.
    expect(usage()).toContain('aria-label="Usage, switch screen"');
    expect(NAV.screens.map((screen) => screen.id)).toContain("settings");
    expect(usage()).toContain('aria-label="Settings"');
  });
});

describe("HeaderSettingsButton", () => {
  it("is a named icon button at the LEFT of every screen header, before the breadcrumb", () => {
    const html = render(NAV, <ScreenHeader screenId="providers" title="Providers" actions={<b id="act" />} />);
    const gear = html.match(/<button[^>]*data-slot="app-settings"[^>]*>/)?.[0] ?? "";
    expect(gear).toContain('aria-label="Settings"');
    expect(gear).toContain('data-state="closed"');
    expect(gear).not.toContain("aria-current");
    expect(gear).not.toMatch(/\sdisabled(=|\s|>)/);
    // Compare where each control STARTS (the gear's long class list puts its data-slot late in the tag).
    const gearStart = html.search(/<button[^>]*data-slot="app-settings"/);
    expect(gearStart).toBeGreaterThanOrEqual(0);
    expect(gearStart).toBeLessThan(html.indexOf("<nav"));
    expect(gearStart).toBeLessThan(html.indexOf('id="act"'));
  });

  it("marks the open Settings screen as the current page", () => {
    const html = render(
      { ...NAV, view: "settings" },
      <ScreenHeader screenId="settings" title="Settings" section="Appearance" />,
    );
    const gear = html.match(/<button[^>]*data-slot="app-settings"[^>]*>/)?.[0] ?? "";
    expect(gear).toContain('aria-current="page"');
    expect(gear).toContain('data-state="open"');
    // The breadcrumb's own current page is still the single `li`; the gear adds no second heading.
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("renders nothing without app navigation", () => {
    expect(renderToStaticMarkup(<HeaderSettingsButton />)).toBe("");
  });
});

describe("UsageHeaderPortal", () => {
  it("renders nothing while the header is not showing Usage (no slot element)", () => {
    expect(render(NAV, <UsageHeaderPortal slot="provider">x</UsageHeaderPortal>)).toBe("");
  });

  it("puts picker content behind a leading slash and the action cluster in as-is", () => {
    const slots = {
      provider: { id: "prov" } as HTMLElement,
      actions: { id: "act" } as HTMLElement,
    };
    const html = render(
      NAV,
      <UsageHeaderSlotsProvider slots={slots}>
        <UsageHeaderPortal slot="provider"><i id="p" /></UsageHeaderPortal>
        <UsageHeaderPortal slot="actions"><i id="a" /></UsageHeaderPortal>
      </UsageHeaderSlotsProvider>,
    );
    expect(html).toMatch(/data-portal="prov"><span[^>]*aria-hidden="true"[^>]*>\/<\/span><i id="p">/);
    expect(html).toMatch(/data-portal="act"><i id="a"/);
  });

});

describe("HeaderPicker", () => {
  it("is the primitive's picker tone, touch-sized, with no border, fill or shadow", () => {
    const picker = renderToStaticMarkup(<HeaderPicker>All providers</HeaderPicker>);
    expect(picker).toMatch(/\stext-foreground\s/);
    expect(picker).toContain("pointer-coarse:min-h-11");
    // 24px on a pointer (WCAG 2.5.8): the label alone would make it a 20px target.
    expect(picker).toMatch(/\smin-h-6\s/);
    expect(picker).not.toMatch(/\sbg-|\sshadow|\sborder-/);
  });

  it("takes the muted context tone when another crumb follows it", () => {
    const context = renderToStaticMarkup(<HeaderPicker tone="muted">Usage</HeaderPicker>);
    expect(context).toMatch(/\stext-muted-foreground\s/);
  });
});

describe("HeaderRefreshButton", () => {
  it("names itself, reports busy, and disables while busy", () => {
    const idle = renderToStaticMarkup(<HeaderRefreshButton label="Refresh limits" busy={false} onClick={() => {}} />);
    expect(idle).toContain('aria-label="Refresh limits"');
    expect(idle).toContain('aria-busy="false"');
    expect(idle).not.toMatch(/\sdisabled(=|\s|>)/);
    const busy = renderToStaticMarkup(<HeaderRefreshButton label="Refresh limits" busy onClick={() => {}} />);
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toMatch(/\sdisabled(=|\s|>)/);
  });
});

describe("AppHeader", () => {
  it("shares the 12/20px page gutter so the breadcrumb lines up with the content below", () => {
    const header = render(NAV, <AppHeader><AppHeaderEnd /></AppHeader>);
    expect(header).toContain("ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)");
    expect(PAGE_RHYTHM).toContain("px-3 pt-4 pb-8 sm:px-5");
    expect(PAGE_RHYTHM).toContain("gap-6");
  });

  it("makes desktop header space draggable without marking its buttons as drag targets", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn() } });
    const html = render(NAV, <AppHeader><AppHeaderEnd /></AppHeader>);
    expect(html).toMatch(/<header[^>]*data-tauri-drag-region="deep"/);
    expect(html).not.toMatch(/<button[^>]*data-tauri-drag-region/);
  });
});

describe("AppHeaderClose", () => {
  it("is always present on secondary screens, named for the Usage it returns to", () => {
    const back = render({ ...NAV, view: "providers" }, <AppHeaderClose />);
    expect(back).toContain('aria-label="Back to Usage"');
    expect(back).not.toContain('aria-label="Close"');
  });

  it("is omitted on Usage when the native title bar already has a close button", () => {
    expect(render({ ...NAV, view: "usage", homeClose: false }, <AppHeaderClose />)).toBe("");
  });

  it("is drawn on Usage in a browser tab (no native title bar)", () => {
    expect(render({ ...NAV, view: "usage", homeClose: true }, <AppHeaderClose />)).toContain(
      'aria-label="Close"',
    );
  });
});

describe("AppHeaderEnd", () => {
  it("ends in the Close X in the browser, with no window commands (the gear is drawn by ScreenHeader)", () => {
    const html = render({ ...NAV, view: "usage", homeClose: true }, <AppHeaderEnd />);
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain('aria-label="Settings"');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('aria-label="Window controls"');
    const titleBar = render({ ...NAV, view: "usage", homeClose: false }, <AppHeaderEnd />);
    expect(titleBar).not.toContain('aria-label="Settings"');
    expect(titleBar).not.toContain('aria-label="Close"');
  });

  it("keeps the native window commands on Usage in the desktop shell", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn() } });
    const html = render({ ...NAV, view: "usage", homeClose: true }, <AppHeaderEnd />);
    expect([...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "Window controls",
      "Minimize window",
      "Maximize window",
      "Close window",
    ]);
    expect(html.match(/focus-visible:ring-2/g)).toHaveLength(3);
  });

  it("distinguishes backing out of a secondary desktop view from closing the window", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn() } });
    const html = render(NAV, <AppHeaderEnd />);
    expect(html).toContain('aria-label="Back to Usage"');
    expect(html).toContain('aria-label="Close window"');
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain('aria-label="Settings"');
    expect(html.indexOf('aria-label="Back to Usage"')).toBeLessThan(html.indexOf('aria-label="Window controls"'));
  });
});
