import { beforeEach, describe, expect, it } from "vitest";

import {
  closeThemeEditor,
  getThemeEditorState,
  toggleThemeEditorForTheme,
  openThemeEditor,
} from "./themeEditorStore";

beforeEach(() => {
  closeThemeEditor();
});

describe("theme editor session store", () => {
  it("opens, increments session ids and closes", () => {
    expect(getThemeEditorState().session).toBeNull();
    openThemeEditor({
      editingThemeId: null,
      seedThemeId: "burnrate-dark",
      seedName: null,
      initialAppearance: "dark",
    });
    const first = getThemeEditorState().session;
    expect(first?.id).toBe(1);
    expect(first?.seedThemeId).toBe("burnrate-dark");

    openThemeEditor({
      editingThemeId: "my-theme",
      seedThemeId: null,
      seedName: "My theme",
      initialAppearance: "light",
    });
    expect(getThemeEditorState().session?.id).toBe(2);

    closeThemeEditor();
    expect(getThemeEditorState().session).toBeNull();
  });

  it("toggles the editor for the active theme half", () => {
    toggleThemeEditorForTheme({
      theme: "burnrate-dark",
      themeHalves: { dark: "burnrate-dark" },
      initialAppearance: "dark",
    });
    const session = getThemeEditorState().session;
    expect(session).toMatchObject({
      editingThemeId: null,
      seedThemeId: "burnrate-dark",
      initialAppearance: "dark",
    });

    toggleThemeEditorForTheme({
      theme: "burnrate-dark",
      themeHalves: null,
      initialAppearance: "dark",
    });
    expect(getThemeEditorState().session).toBeNull();
  });
});
