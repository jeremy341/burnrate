import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LimitsEmptyState } from "./UsageLimitsStates";

describe("LimitsEmptyState", () => {
  it("says what to do next instead of ending on a dead sentence", () => {
    const markup = renderToStaticMarkup(<LimitsEmptyState />);
    expect(markup).toContain('data-slot="limits-empty"');
    expect(markup).toContain("Connect an agent to see how much you have left.");
    expect(markup).toContain("<button");
    expect(markup).not.toContain("selected environments");
  });
});
