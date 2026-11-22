import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LimitsSkeleton } from "~/components/skeletons/LimitsSkeleton";

describe("LimitsSkeleton", () => {
  it("holds the loaded view's section rhythm so figures do not jump into place", () => {
    const markup = renderToStaticMarkup(<LimitsSkeleton />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("flex flex-col gap-5");
    expect(markup).not.toContain("gap-8");
    expect(markup).toContain("Checking your limits…");
  });
});
