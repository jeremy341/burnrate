/**
 * Preset: Burnrate Dark (the user's "test" palette from docs/THEME.md).
 *
 * `src/themes/registry.ts` eagerly globs `./presets/*.ts` and registers every
 * exported `theme`. The definition itself lives in `src/themes/engine/` so the
 * runtime palette pipeline and this drop-in preset share one source of truth.
 *
 * Seeds: appearance dark, canvas `#181818`, accent `#ffffff`.
 */
import type { ThemeDefinition } from "~/shared/themePalettes";
import { burnrateDark } from "~/themes/engine/burnrateDark";

/** Registry contract: a preset module exports `theme: ThemeDefinition`. */
export const theme: ThemeDefinition = burnrateDark;

/** Kept for callers that prefer the naming used by the engine module. */
export const BURNRATE_DARK_THEME = theme;

export default theme;
