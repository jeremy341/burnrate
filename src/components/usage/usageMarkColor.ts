import type { CSSProperties } from "react";

/**
 * Chart marks (lines, dots, legend swatches) must reach 3:1 against the surface they are drawn on
 * (WCAG 1.4.11), but a provider's brand colour is fixed per entity: Codex is `#111111`, which vanishes
 * on the `#000` dark canvas. A mark keeps the provider's hue and is only lifted toward white (dark
 * surface) or darkened toward black (light surface) as far as needed, so a colour still means one provider.
 */

/** Worst-case surfaces a mark sits on: the light card and the raised dark card. */
export const MARK_SURFACE = { light: "#ffffff", dark: "#111111" } as const;
export const MARK_MIN_CONTRAST = 3;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

type Rgb = readonly [number, number, number];

export function parseHex(color: string): Rgb | null {
  const match = HEX.exec(color.trim());
  if (match === null) return null;
  const digits = match[1]!;
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

/** `color` itself when it already clears `minimum` on `surface`; otherwise the nearest tint or shade that does. */
export function ensureContrast(color: string, surface: string, minimum = MARK_MIN_CONTRAST): string {
  const rgb = parseHex(color);
  const background = parseHex(surface);
  // Not a hex colour (a CSS variable, oklch(), a keyword): it already follows the theme or cannot be measured.
  if (rgb === null || background === null) return color;
  if (contrastRatio(rgb, background) >= minimum) return color;
  const target: Rgb = luminance(background) < 0.5 ? [255, 255, 255] : [0, 0, 0];
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(rgb, target, step / 20);
    if (contrastRatio(candidate, background) >= minimum) return toHex(candidate);
  }
  return toHex(target);
}

/** The colour a mark of this provider uses in each theme. */
export function markColors(color: string): { readonly light: string; readonly dark: string } {
  return {
    light: ensureContrast(color, MARK_SURFACE.light),
    dark: ensureContrast(color, MARK_SURFACE.dark),
  };
}

/**
 * Inline custom properties for an element that draws a provider mark. Pair with `MARK_CLASS`: the class
 * picks the light or dark value (`.dark` on the root) into `--usage-mark`, which fill/stroke read.
 */
export function markStyle(color: string): CSSProperties {
  const { light, dark } = markColors(color);
  return { "--usage-mark-light": light, "--usage-mark-dark": dark } as CSSProperties;
}

export const MARK_CLASS =
  "[--usage-mark:var(--usage-mark-light)] dark:[--usage-mark:var(--usage-mark-dark)]";
