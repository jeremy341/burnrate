/**
 * Verbatim port of T3 Code's `apps/web/src/appearanceContrast.ts`.
 * Burnrate keeps `highContrast` rather than T3's numeric slider; the default 100
 * reproduces the stock `index.css` contrast chain (base 100%, boost 0%).
 */

/** T3's 50-200 integer contrast setting. */
export type AppearanceContrast = number;

export function applyAppearanceContrast(root: HTMLElement, contrast: AppearanceContrast): void {
  root.style.setProperty("--appearance-contrast-base", `${Math.min(contrast, 100)}%`);
  root.style.setProperty("--appearance-contrast-boost", `${Math.max(contrast - 100, 0)}%`);
  root.style.setProperty(
    "--appearance-contrast-border-boost",
    `${Math.max(contrast - 100, 0) / 4}%`,
  );
}
