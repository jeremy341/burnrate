import { describe, expect, it } from "vitest";

import { modePanes } from "./AppearanceSettingsPanel";
import { STANDARD_THEME_CARDS } from "./ThemePreviewCircles";

const previews = STANDARD_THEME_CARDS[0]!.previews;
const light = previews.find((preview) => preview.mode === "light")!.colors;
const dark = previews.find((preview) => preview.mode === "dark")!.colors;

describe("modePanes", () => {
  it("splits the System tile into light and dark halves", () => {
    const panes = modePanes("system", light, dark);
    expect(panes).toHaveLength(2);
    expect(panes[0]).toEqual({ clip: "left", colors: light });
    expect(panes[1]).toEqual({ clip: "right", colors: dark });
  });

  it("uses a single pane for an explicit mode", () => {
    expect(modePanes("light", light, dark)).toEqual([{ colors: light }]);
    expect(modePanes("dark", light, dark)).toEqual([{ colors: dark }]);
  });
});
