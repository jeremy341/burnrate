/**
 * Preset: Burnrate Light.
 *
 * The stock T3 light palette (the same tokens `src/index.css` resolves when no
 * theme id is active), published as a regular `ThemeDefinition` so the theme
 * library can show it next to Burnrate Dark and the user's custom themes.
 *
 * `lightThemeId` stays `null` by default: the stock palette is already the
 * fallback, and selecting this preset just pins it explicitly.
 */
import type { ThemeDefinition } from "~/shared/themePalettes";
import { T3_CODE_LIGHT_THEME_COLORS } from "~/shared/themePalettes";

export const BURNRATE_LIGHT_THEME_ID = "burnrate-light";

/** Registry contract: a preset module exports `theme: ThemeDefinition`. */
export const theme: ThemeDefinition = {
  id: BURNRATE_LIGHT_THEME_ID,
  label: "Burnrate Light",
  appearance: "light",
  managed: true,
  colors: T3_CODE_LIGHT_THEME_COLORS,
};

/** Kept for symmetry with `burnrate-dark.ts`. */
export const BURNRATE_LIGHT_THEME = theme;

export default theme;
