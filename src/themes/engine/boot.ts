/**
 * First-paint palette helpers.
 *
 * The inline script in index.html cannot import TypeScript modules, so before
 * React mounts it reads only `localStorage["burnrate.boot"]` (a precomputed
 * `{ dark, bg, fg }`) and `localStorage["burnrate.settings.mirror"]` for the mode.
 * `appearance.ts` writes that key synchronously on every theme/mode change.
 * Keeping the computation here makes it unit-testable (themeBoot.test.ts).
 */
import type { AppSettings } from "~/settings/schema";
import { getThemeColorsForMode, getThemeDefinition, themeColorToHex } from "~/themePalette";
import type { ThemeAppearance } from "~/shared/themePalettes";

import { BOOT_STORAGE_KEY } from "../store";
import { resolveAppearance, resolveThemeId } from "./resolve";

export interface BootPalette {
  dark: boolean;
  bg: string;
  fg: string;
}

/** Stock fallbacks (no `data-theme-id`): T3's painted canvas/foreground. */
export const STOCK_BOOT: Readonly<Record<ThemeAppearance, { bg: string; fg: string }>> = {
  light: { bg: "#fcfcfc", fg: "#27272a" },
  dark: { bg: "#181818", fg: "#f2f2f2" },
};

export function resolveBootAppearance(
  mode: AppSettings["appearance"]["themeMode"],
  systemDark: boolean,
): ThemeAppearance {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

export function computeBootPalette(settings: AppSettings, systemDark: boolean): BootPalette {
  const mode = resolveAppearance(settings, systemDark);
  const themeId = resolveThemeId(settings, mode);
  const definition = themeId ? getThemeDefinition(themeId) : null;
  const colors = definition ? getThemeColorsForMode(definition, mode) : null;
  if (!colors) {
    const stock = STOCK_BOOT[mode];
    return { dark: mode === "dark", bg: stock.bg, fg: stock.fg };
  }
  return {
    dark: mode === "dark",
    bg: themeColorToHex(colors.canvas) ?? STOCK_BOOT[mode].bg,
    fg: themeColorToHex(colors.text) ?? STOCK_BOOT[mode].fg,
  };
}

export function writeBootPalette(palette: BootPalette): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BOOT_STORAGE_KEY, JSON.stringify(palette));
  } catch {
    /* storage unavailable: the boot script falls back to the mirror */
  }
}

export function readBootPalette(): BootPalette | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BOOT_STORAGE_KEY) ?? "null");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as BootPalette).dark === "boolean" &&
      typeof (parsed as BootPalette).bg === "string" &&
      typeof (parsed as BootPalette).fg === "string"
    ) {
      return parsed as BootPalette;
    }
  } catch {
    /* malformed mirror */
  }
  return null;
}
