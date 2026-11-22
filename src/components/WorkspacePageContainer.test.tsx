import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WIDTH_CLASS, WorkspacePageContainer } from "./WorkspacePageContainer";

describe("WorkspacePageContainer widths", () => {
  it("keeps the 1024px measure on small windows and lets dashboards use the window from 1280px", () => {
    for (const width of ["wide", "expanded"] as const) {
      expect(WIDTH_CLASS[width]).toMatch(/\bmax-w-(5xl|6xl)\b/);
      expect(WIDTH_CLASS[width]).toMatch(/(xl|lg):max-w-none/);
      // A ceiling remains so a 4K monitor does not stretch rows beyond reading distance.
      expect(WIDTH_CLASS[width]).toContain("2xl:max-w-[120rem]");
    }
  });

  it("gives Usage T3's own frame: a 1024px column at every width with T3's padding", () => {
    expect(WIDTH_CLASS.usage).toBe("max-w-5xl px-5 pt-6 pb-12 sm:px-6");
    const html = renderToStaticMarkup(<WorkspacePageContainer width="usage">x</WorkspacePageContainer>);
    expect(html).toContain('data-page-width="usage"');
    expect(html).toMatch(/\spx-5\s/);
    expect(html).toContain("max-w-5xl");
    expect(html).not.toMatch(/max-w-none|\spx-3\s|sm:px-5/);
  });

  it("caps forms and prose instead of stretching them", () => {
    expect(WIDTH_CLASS.form).not.toContain("max-w-none");
    expect(WIDTH_CLASS.readable).not.toContain("max-w-none");
  });

  it("renders the width class and never grows the gutter, so the header keeps lining up", () => {
    const html = renderToStaticMarkup(<WorkspacePageContainer width="wide" className="px-3 sm:px-5">x</WorkspacePageContainer>);
    expect(html).toContain("xl:max-w-none");
    expect(html).toContain('data-page-width="wide"');
    expect(html).toContain("min-w-0");
    expect(html).not.toMatch(/xl:px-|2xl:px-/);
    // A screen that passes no padding still gets the header's gutter (Settings used to get 20/24px).
    const bare = renderToStaticMarkup(<WorkspacePageContainer>x</WorkspacePageContainer>);
    expect(bare).toMatch(/\spx-3\s/);
    expect(bare).toMatch(/\ssm:px-5[\s"]/);
    expect(bare).not.toMatch(/\bsm:px-6\b/);
  });

  it("lets a caller's explicit cap win over the width variant", () => {
    const html = renderToStaticMarkup(<WorkspacePageContainer className="max-w-[45rem]">x</WorkspacePageContainer>);
    expect(html).toContain("max-w-[45rem]");
    expect(html).not.toContain("max-w-4xl");
  });
});
