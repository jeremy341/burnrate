import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WindowControls } from "./window-controls";

describe("WindowControls", () => {
  it("uses the shared header icon size instead of a taller local override", () => {
    const markup = renderToStaticMarkup(<WindowControls active={false} />);
    expect(markup).not.toContain("sm:size-8");
    // The icon-sm variant supplies size-8 sm:size-7, matching the other header buttons.
    expect(markup).toContain("sm:size-7");
  });

  it("keeps a name on every titlebar action and the forced-colors focus ring", () => {
    const markup = renderToStaticMarkup(<WindowControls active={false} />);
    for (const label of ["Minimize window", "Maximize window", "Close window"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toContain("forced-colors:focus-visible:outline-2");
  });
});
