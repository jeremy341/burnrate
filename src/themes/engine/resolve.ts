/** Shared resolution of Burnrate's theme-mode + per-appearance halves. */
import type { AppSettings } from "~/settings/schema";
import type { ThemeAppearance } from "~/shared/themePalettes";
import {
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  type ThemeHalves,
} from "~/themePalette";

export function themeHalvesFromSettings(settings: AppSettings): ThemeHalves {
  const appearance = settings.appearance;
  return {
    light: appearance.lightThemeId ?? undefined,
    dark: appearance.darkThemeId ?? undefined,
  };
}

/** A single-appearance theme forces its own mode instead of inverting its colors. */
export function resolveAppearance(settings: AppSettings, systemDark: boolean): ThemeAppearance {
  const mode = settings.appearance.themeMode;
  const appearance: ThemeAppearance =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;
  const themeId = appearance === "dark" ? settings.appearance.darkThemeId : settings.appearance.lightThemeId;
  const definition = themeId ? getThemeDefinition(themeId) : null;
  if (definition && getThemeColorsForMode(definition, appearance) === null) {
    return definition.appearance;
  }
  return appearance;
}

/** The effective theme id for a resolved appearance ("" = stock palette). */
export function resolveThemeId(settings: AppSettings, appearance: ThemeAppearance): string {
  return resolveThemeHalf("", themeHalvesFromSettings(settings), appearance);
}
