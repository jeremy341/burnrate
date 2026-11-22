/**
 * Font helpers for Settings → Appearance (trimmed from T3's `appearanceFonts.ts`).
 *
 * Burnrate keeps two font choices only: the interface font (`--font-sans`) and
 * the monospace font (`--font-mono`). Sizes, prompt/composer and terminal fonts
 * from T3 are intentionally not ported; `src/index.css` owns the default stacks
 * and this module only writes inline overrides on `<html>`.
 *
 * `startAppearanceFonts()` follows the settings store, so a font picked in
 * settings applies everywhere without a reload. It is idempotent and a no-op
 * outside the browser (vitest runs in node).
 */
import interLatinUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";

import { getSettings, subscribe } from "~/settings/store";

/** Mirrors the `--font-sans` default in `src/index.css`. */
export const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif';

/** Mirrors the `--font-mono` default in `src/index.css`. */
export const DEFAULT_MONO_FONT_STACK =
  'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

/** Normalise a comma-separated family list, or null when nothing is left. */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

/** A custom family list followed by the safe default stack (T3's behaviour). */
export function appearanceFontStack(
  custom: string | null | undefined,
  defaultStack: string,
): string {
  const families = cssFontFamilies(custom ?? "");
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

export interface AppearanceFontPreferences {
  readonly fontFamily: string | null;
  readonly monoFontFamily: string | null;
}

const FONT_VARIABLES: ReadonlyArray<
  readonly [variable: string, pick: (prefs: AppearanceFontPreferences) => string | null, fallback: string]
> = [
  ["--font-sans", (prefs) => prefs.fontFamily, DEFAULT_SANS_FONT_STACK],
  ["--font-mono", (prefs) => prefs.monoFontFamily, DEFAULT_MONO_FONT_STACK],
];

/**
 * Write (or clear) the runtime font overrides. Clearing the property when no
 * custom family is set keeps index.css's `@theme` defaults in charge, including
 * the `@fontsource-variable/inter` face and the per-OS stacks.
 */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  for (const [variable, pick, fallback] of FONT_VARIABLES) {
    const families = cssFontFamilies(pick(preferences) ?? "");
    if (families === null) root.style.removeProperty(variable);
    else root.style.setProperty(variable, `${families}, ${fallback}`);
  }
}

const FONT_PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";
const PROBE_FONT_SIZE = 16;

let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string, text = FONT_PROBE_TEXT): number | null {
  if (typeof document === "undefined") return null;
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `${PROBE_FONT_SIZE}px ${fontList}`;
  return fontProbeContext.measureText(text).width;
}

/** Probes canvas metrics because `document.fonts.check()` accepts uninstalled families. */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true;
  try {
    for (const generic of ["monospace", "serif", "sans-serif"]) {
      const baseline = probeWidth(generic);
      const candidate = probeWidth(`${families}, ${generic}`);
      if (baseline === null || candidate === null) return false;
      if (candidate !== baseline) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

/** Reject proportional faces for the code/console font. Unknown faces pass. */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  if (typeof document === "undefined") return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

const SANS_GENERIC_CANDIDATES = [
  "Segoe UI",
  "Roboto",
  "Noto Sans",
  "Ubuntu",
  "Cantarell",
  "DejaVu Sans",
  "Liberation Sans",
  "Helvetica Neue",
  "Arial",
] as const;

const MONO_GENERIC_CANDIDATES = [
  "Menlo",
  "Consolas",
  "Cascadia Mono",
  "DejaVu Sans Mono",
  "Ubuntu Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Roboto Mono",
  "Monaco",
  "Courier New",
] as const;

const GENERIC_PROBE_TEXT = "RagIl10O@ fjord quiz";

function measureDomProbeWidth(fontFamily: string): number | null {
  try {
    const body = document.body;
    if (!body) return null;
    const span = document.createElement("span");
    span.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px;";
    span.style.fontFamily = fontFamily;
    span.textContent = GENERIC_PROBE_TEXT;
    body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width > 0 ? width : null;
  } catch {
    return null;
  }
}

function widthsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

function resolveGenericFamilyLabel(generic: string): string | null {
  if (typeof document === "undefined") return null;
  const lower = generic.toLowerCase();
  if (lower === "serif") return null;
  const monoLike = lower === "ui-monospace" || lower === "monospace";
  const genericWidth = measureDomProbeWidth(generic);
  if (genericWidth === null) return null;
  for (const candidate of monoLike ? MONO_GENERIC_CANDIDATES : SANS_GENERIC_CANDIDATES) {
    if (!isFontFamilyAvailable(candidate)) continue;
    const candidateWidth = measureDomProbeWidth(`"${candidate}"`);
    if (candidateWidth !== null && widthsMatch(genericWidth, candidateWidth)) return candidate;
  }
  // Unnameable Apple faces need -apple-system metrics to tell the UI face from SF Mono.
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform)) {
    const systemWidth = measureDomProbeWidth("-apple-system");
    if (systemWidth !== null && widthsMatch(genericWidth, systemWidth)) return "SF Pro";
    return monoLike ? "SF Mono" : "SF Pro";
  }
  return null;
}

/** Human-readable label for a CSS family list; useful for previews. */
export function displayFontFamily(family: string): string {
  const label = family
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim()
    .toLowerCase();
  if (label === "sf pro") return appearanceFontStack(family, DEFAULT_SANS_FONT_STACK);
  if (label === "sf mono") return DEFAULT_MONO_FONT_STACK;
  return cssFontFamilies(family) ?? "";
}

/** Best available label for the first usable family in a default stack. */
export function resolveDefaultFamilyLabel(stack: string): string | null {
  if (typeof document === "undefined") return null;
  for (const raw of stack.split(",")) {
    const family = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (family.length === 0) continue;
    if (
      /^(system-ui|sans-serif|serif|monospace|ui-monospace|-apple-system|BlinkMacSystemFont)$/i.test(
        family,
      )
    ) {
      const resolved = resolveGenericFamilyLabel(family);
      if (resolved !== null) return resolved;
      continue;
    }
    if (isFontFamilyAvailable(family)) return family;
  }
  return null;
}

export interface InstalledFontFamiliesResult {
  readonly families: readonly string[];
  readonly status: "granted" | "denied" | "unsupported";
}

let installedFamiliesCache: InstalledFontFamiliesResult | null = null;

/** Call from a user gesture; the first call prompts for local-fonts permission. */
export async function queryInstalledFontFamilies(): Promise<InstalledFontFamiliesResult> {
  if (installedFamiliesCache !== null) return installedFamiliesCache;
  const query =
    typeof window === "undefined"
      ? undefined
      : (
          window as Window & {
            queryLocalFonts?: () => Promise<ReadonlyArray<{ readonly family: string }>>;
          }
        ).queryLocalFonts;
  if (typeof query !== "function") {
    installedFamiliesCache = { families: [], status: "unsupported" };
    return installedFamiliesCache;
  }
  try {
    const fonts = await query.call(window);
    const families = [...new Set(fonts.map((font) => font.family))]
      // Dot-prefixed macOS UI faces often refuse to render in web content.
      .filter((family) => !family.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    // Denied access can return an empty list instead of throwing.
    if (families.length === 0) return { families: [], status: "denied" };
    installedFamiliesCache = { families, status: "granted" };
    return installedFamiliesCache;
  } catch {
    return { families: [], status: "denied" };
  }
}

let interPreloaded = false;

/**
 * Preload the default interface font at boot. The `@font-face` rules in index.css are only
 * fetched once the first matching text is laid out; preloading the latin face (the same hashed URL
 * Vite rewrites the CSS to) and asking the FontFaceSet to load it means the first painted frame
 * already uses Inter Variable, as in T3, instead of swapping from the system stack. Idempotent and
 * a no-op outside a browser. Returns true when it added the preload hint.
 */
export function preloadInterFont(doc: Document | undefined = globalThis.document): boolean {
  if (!doc || interPreloaded) return false;
  interPreloaded = true;
  if (!doc.head.querySelector(`link[rel="preload"][href="${interLatinUrl}"]`)) {
    const link = doc.createElement("link");
    link.rel = "preload";
    link.as = "font";
    link.type = "font/woff2";
    link.crossOrigin = "anonymous";
    link.href = interLatinUrl;
    doc.head.appendChild(link);
  }
  // Variable face: one request covers every weight, so load the two the shell uses most.
  void doc.fonts?.load('400 1em "Inter Variable"').catch(() => {});
  void doc.fonts?.load('600 1em "Inter Variable"').catch(() => {});
  return true;
}

/** Test hook: forget that the preload hint was added. */
export function resetInterPreload(): void {
  interPreloaded = false;
}

let stopAppearanceFonts: (() => void) | null = null;

/**
 * Subscribe the document root to `appearance.fontFamily` / `monoFontFamily`.
 * Idempotent; returns a stop function. Importing this module starts it in the
 * browser because the settings UI is bundled eagerly and fonts must apply
 * outside Settings too.
 */
export function startAppearanceFonts(): () => void {
  if (typeof document === "undefined") return () => {};
  if (stopAppearanceFonts !== null) return stopAppearanceFonts;

  const root = document.documentElement;
  preloadInterFont();
  const apply = () => {
    applyAppearanceFontVariables(root, getSettings().appearance);
  };
  apply();
  const unsubscribe = subscribe(apply);
  const stop = () => {
    unsubscribe();
    stopAppearanceFonts = null;
  };
  stopAppearanceFonts = stop;
  return stop;
}

if (typeof document !== "undefined") {
  startAppearanceFonts();
}
