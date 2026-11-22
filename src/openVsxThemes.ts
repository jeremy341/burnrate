/**
 * Open VSX theme search/install (adapted from T3 Code's `apps/web/src/openVsxThemes.ts`,
 * MIT, T3 Tools Inc.) against Burnrate's own proxy (docs/CONTRACTS.md section 3).
 *
 * Differences from the upstream module, all forced by the real contract:
 * - Search and download go through `/api/themes/openvsx/*` (same origin, opt-in, 5 MiB cap)
 *   instead of contacting open-vsx.org from the browser. The server already sanitises
 *   search results and validates the file url against its allow-list.
 * - The VSIX is unpacked with a tiny, dependency-free ZIP reader (central directory +
 *   `DecompressionStream("deflate-raw")`). Only the theme files declared in
 *   `package.json` `contributes.themes` (plus their `include` chain) are read.
 * - Every archive limit is enforced here as well: entry count, total uncompressed size,
 *   compression ratio, per-file size, include depth and include cycles. A VSIX is
 *   untrusted input even when it comes from Open VSX.
 */
import {
  downloadOpenVsxTheme,
  searchOpenVsxThemes as searchOpenVsxThemeResults,
  type OpenVsxThemeSearchResult,
} from "~/api/themes";
import { msg } from "~/i18n";
import type { ThemeDefinition } from "~/themePalette";
import {
  parseJsoncObject,
  parseVsCodeThemeFile,
  pairVsCodeThemes,
  resolveThemeLabelCollisions,
} from "~/vscodeThemeImport";

/** Mirrors the server cap; checked again before unpacking. */
export const MAX_VSIX_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_THEME_BYTES = 256 * 1024;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
const MAX_PACKAGE_PATH_LENGTH = 1_024;
const MAX_COLOR_VALUE_LENGTH = 128;
const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_DEBOUNCE_MS = 350;

/** Workbench colors the palette derivation actually reads; everything else is dropped. */
const USED_WORKBENCH_COLORS = new Set([
  "activityBar.background",
  "activityBarBadge.background",
  "badge.background",
  "button.background",
  "button.foreground",
  "contrastBorder",
  "descriptionForeground",
  "disabledForeground",
  "dropdown.background",
  "dropdown.border",
  "editor.background",
  "editor.foreground",
  "editor.findMatchBackground",
  "editor.findMatchForeground",
  "editor.findMatchHighlightBackground",
  "editor.findMatchHighlightForeground",
  "editor.selectionBackground",
  "editorCursor.foreground",
  "editorError.foreground",
  "editorGroup.border",
  "editorPane.background",
  "editorWarning.foreground",
  "editorWidget.background",
  "errorForeground",
  "focusBorder",
  "foreground",
  "input.border",
  "input.placeholderForeground",
  "list.activeSelectionBackground",
  "list.hoverBackground",
  "list.inactiveSelectionBackground",
  "menu.background",
  "panel.background",
  "panel.border",
  "progressBar.background",
  "quickInput.background",
  "scrollbarSlider.background",
  "sideBar.background",
  "sideBar.border",
  "sideBar.foreground",
  "terminal.background",
  "terminal.foreground",
  "terminal.selectionBackground",
  "terminalCursor.foreground",
  "textCodeBlock.background",
  "textLink.foreground",
]);

export interface OpenVsxThemeExtension extends OpenVsxThemeSearchResult {
  /** Stable collection id; re-installing replaces exactly this extension's themes. */
  collectionId: string;
}

export interface ParsedVsixTheme {
  theme: ThemeDefinition;
  /** File name inside the VSIX, used to disambiguate themes with the same label. */
  sourceName: string;
  /** Full package path, used to derive a stable theme id. */
  sourcePath: string;
}

export interface VsixImport {
  themes: ParsedVsixTheme[];
  /** Themes that were declared but could not be parsed; the rest are still usable. */
  failures: string[];
}

type ThemeContribution = { label?: unknown; uiTheme?: unknown; path?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// ZIP reader (central directory; stored and deflate entries only)
// ---------------------------------------------------------------------------

interface ZipEntry {
  path: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

interface ZipArchive {
  has(path: string): boolean;
  read(path: string, limit: number): Promise<Uint8Array>;
}

function packageError(message: string): Error {
  return new Error(message);
}

const utf8 = new TextDecoder("utf-8");

function normalizePackagePath(path: string): string {
  if (path.length > MAX_PACKAGE_PATH_LENGTH || path.includes("\0")) {
    throw packageError(msg("Theme path is not a safe relative package path."));
  }
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw packageError(msg("Theme path is not a safe relative package path."));
  }
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw packageError(msg("Theme path escapes the extension package."));
    segments.push(segment);
  }
  if (segments.length === 0) throw packageError(msg("Theme path is not a safe relative package path."));
  return segments.join("/");
}

/** Resolve a theme's `include` relative to the file that declares it, never above `extension/`. */
function resolveIncludePath(path: string, relativeTo: string): string {
  if (path.length > MAX_PACKAGE_PATH_LENGTH || path.includes("\0")) {
    throw packageError(msg("Theme path is not a safe relative package path."));
  }
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw packageError(msg("Theme path is not a safe relative package path."));
  }
  const base = relativeTo.split("/").slice(0, -1);
  const segments = [...base];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= 1) throw packageError(msg("Theme path escapes the extension package."));
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments[0] !== "extension") segments.unshift("extension");
  return segments.join("/");
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // The comment is at most 65535 bytes, so the record starts within the last 65557 bytes.
  const minimum = Math.max(0, length - 65_557);
  for (let offset = length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    if (offset + 22 + view.getUint16(offset + 20, true) === length) return offset;
  }
  return -1;
}

function openZip(bytes: Uint8Array): ZipArchive {
  if (bytes.byteLength > MAX_VSIX_BYTES) {
    throw packageError(msg("That theme extension is too large to import safely."));
  }
  if (bytes.byteLength < 22) throw packageError(msg("That extension package has no ZIP directory."));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);
  if (eocd < 0) throw packageError(msg("That extension package has no ZIP directory."));

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw packageError(msg("That extension package uses an unsupported multi-disk ZIP."));
  }
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw packageError(msg("That extension package has unsupported ZIP64 metadata."));
  }
  if (directoryOffset + directorySize !== eocd || directoryOffset + directorySize > bytes.byteLength) {
    throw packageError(msg("That extension package has an invalid ZIP directory."));
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw packageError(msg("That extension package has too many files."));
  }

  const entries = new Map<string, ZipEntry>();
  let offset = directoryOffset;
  let count = 0;
  let totalUncompressed = 0;
  while (offset < eocd) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
      throw packageError(msg("That extension package has an invalid ZIP directory."));
    }
    count += 1;
    if (count > MAX_ZIP_ENTRIES) throw packageError(msg("That extension package has too many files."));

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    if (flags & 0x0001) throw packageError(msg("That extension package is encrypted."));
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw packageError(msg("That extension package has unsupported ZIP64 metadata."));
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw packageError(msg("That extension package expands beyond the safe import limit."));
    }
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)) {
      throw packageError(msg("That extension package has an unsafe compression ratio."));
    }
    if (localOffset + 30 > directoryOffset) {
      throw packageError(msg("That extension package has an invalid ZIP directory."));
    }

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = utf8.decode(nameBytes);
    offset += 46 + nameLength + extraLength + commentLength;

    if (rawName.endsWith("/")) continue; // directory marker
    const path = normalizePackagePath(rawName);
    if (entries.has(path)) {
      throw packageError(msg("That extension package contains duplicate files."));
    }
    entries.set(path, { path, method, compressedSize, uncompressedSize, localOffset });
  }
  if (offset !== eocd) throw packageError(msg("That extension package has an invalid ZIP directory."));

  const dataOffset = (entry: ZipEntry): number => {
    if (entry.localOffset + 30 > bytes.byteLength) {
      throw packageError(msg("That extension package has an invalid ZIP directory."));
    }
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw packageError(msg("That extension package has an invalid ZIP directory."));
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > bytes.byteLength) {
      throw packageError(msg("That extension package has an invalid ZIP directory."));
    }
    return start;
  };

  return {
    has: (path) => entries.has(path),
    async read(path, limit) {
      const entry = entries.get(path);
      if (!entry) {
        throw packageError(msg("{path} is missing from the extension package.", { path }));
      }
      if (entry.uncompressedSize > limit) {
        throw packageError(msg("{path} is too large.", { path }));
      }
      const start = dataOffset(entry);
      const compressed = new Uint8Array(bytes.subarray(start, start + entry.compressedSize));
      if (entry.method === 0) {
        if (compressed.byteLength > limit) {
          throw packageError(msg("{path} is too large.", { path }));
        }
        return compressed;
      }
      if (entry.method === 8) return inflateRaw(compressed, limit);
      throw packageError(msg("That extension package uses an unsupported compression method."));
    },
  };
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw packageError(msg("This browser cannot unpack theme packages."));
  }
  // Copy into a plain ArrayBuffer-backed view: `Blob` rejects a shared ArrayBuffer type.
  const input = new Uint8Array(data.byteLength);
  input.set(data);
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw packageError(msg("Theme file is too large."));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readZipText(
  archive: ZipArchive,
  path: string,
  description: string,
  limit: number,
): Promise<string> {
  if (!archive.has(path)) {
    throw new Error(msg("{description} is missing from the extension package.", { description }));
  }
  try {
    return utf8.decode(await archive.read(path, limit));
  } catch (cause) {
    throw cause instanceof Error
      ? cause
      : new Error(msg("{description} could not be read.", { description }));
  }
}

// ---------------------------------------------------------------------------
// VSIX -> theme definitions
// ---------------------------------------------------------------------------

function themeContributions(manifest: Record<string, unknown>): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  const themes = contributes ? contributes.themes : undefined;
  return Array.isArray(themes) ? (themes.filter(isRecord) as ThemeContribution[]) : [];
}

interface OpenVsxExpectedPackage {
  id: string;
  version?: string;
}

function sanitizeThemeObject(value: Record<string, unknown>): Record<string, unknown> {
  const colors: Record<string, string> = {};
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      if (
        USED_WORKBENCH_COLORS.has(key) &&
        typeof color === "string" &&
        color.length <= MAX_COLOR_VALUE_LENGTH
      ) {
        colors[key] = color;
      }
    }
  }
  return {
    ...(typeof value.include === "string" ? { include: value.include } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    colors,
  };
}

async function loadThemeObject(
  archive: ZipArchive,
  path: string,
  cache: Map<string, Record<string, unknown>>,
  budget: { files: number },
  ancestors: ReadonlySet<string> = new Set(),
): Promise<Record<string, unknown>> {
  if (ancestors.size >= MAX_INCLUDE_DEPTH) {
    throw new Error(msg("Theme includes are nested too deeply."));
  }
  if (ancestors.has(path)) throw new Error(msg("Theme includes contain a cycle."));
  const cached = cache.get(path);
  if (cached) return cached;
  budget.files += 1;
  if (budget.files > MAX_RESOLVED_THEME_FILES) {
    throw new Error(msg("That extension references too many theme files."));
  }

  const text = await readZipText(archive, path, path, MAX_THEME_BYTES);
  const value = sanitizeThemeObject(parseJsoncObject(text, path));
  const include = value.include;
  if (typeof include !== "string") {
    cache.set(path, value);
    return value;
  }

  const includePath = resolveIncludePath(include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = await loadThemeObject(archive, includePath, cache, budget, nextAncestors);
  const resolved = {
    ...base,
    ...value,
    colors: {
      ...(isRecord(base.colors) ? base.colors : {}),
      ...(isRecord(value.colors) ? value.colors : {}),
    },
  };
  cache.set(path, resolved);
  return resolved;
}

function contributionThemeType(uiTheme: unknown): "light" | "dark" | undefined {
  if (uiTheme === "vs" || uiTheme === "hc-light") return "light";
  if (uiTheme === "vs-dark" || uiTheme === "hc-black") return "dark";
  return undefined;
}

/**
 * Unpack a VSIX and parse only the color themes it declares in `contributes.themes`.
 * Throws for package-level problems (not a ZIP, no manifest, no themes); individual
 * broken themes are collected in `failures` so one bad file does not lose the rest.
 */
export async function parseVsixThemes(
  bytes: Uint8Array,
  options: { signal?: AbortSignal; expected?: OpenVsxExpectedPackage } = {},
): Promise<VsixImport> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > MAX_VSIX_BYTES) {
    throw new Error(msg("That theme extension is too large to import safely."));
  }
  const archive = openZip(bytes);

  let manifest: Record<string, unknown>;
  try {
    const manifestText = await readZipText(
      archive,
      "extension/package.json",
      msg("Extension manifest"),
      MAX_MANIFEST_BYTES,
    );
    manifest = parseJsoncObject(manifestText, msg("Extension manifest"));
  } catch (cause) {
    throw cause instanceof Error
      ? cause
      : new Error(msg("That extension package has no readable manifest."));
  }

  const expected = options.expected;
  if (expected) {
    const publisher = typeof manifest.publisher === "string" ? manifest.publisher : "";
    const extensionName = typeof manifest.name === "string" ? manifest.name : "";
    if (
      !publisher ||
      !extensionName ||
      `${publisher}.${extensionName}`.toLowerCase() !== expected.id.toLowerCase()
    ) {
      throw new Error(msg("That extension package does not match the selected Open VSX theme."));
    }
    if (
      typeof expected.version === "string" &&
      expected.version !== "" &&
      manifest.version !== expected.version
    ) {
      throw new Error(msg("That extension package does not match the selected Open VSX theme."));
    }
  }

  const contributions = themeContributions(manifest);
  if (contributions.length === 0) {
    throw new Error(msg("That extension does not contain color themes."));
  }
  if (contributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error(msg("That extension contains too many color themes to import safely."));
  }

  const themes: ParsedVsixTheme[] = [];
  const failures: string[] = [];
  const cache = new Map<string, Record<string, unknown>>();
  const budget = { files: 0 };

  for (const contribution of contributions) {
    options.signal?.throwIfAborted();
    if (typeof contribution.path !== "string" || !contribution.path.trim()) {
      failures.push(msg("A theme in that extension has no path."));
      continue;
    }
    try {
      const path = resolveIncludePath(contribution.path, "extension/package.json");
      const themeValue = await loadThemeObject(archive, path, cache, budget);
      const type = contributionThemeType(contribution.uiTheme);
      const label =
        typeof contribution.label === "string" && contribution.label.trim()
          ? contribution.label.trim()
          : typeof manifest.displayName === "string" && manifest.displayName.trim()
            ? manifest.displayName.trim()
            : typeof manifest.name === "string" && manifest.name.trim()
              ? manifest.name.trim()
              : msg("VS Code theme");
      const theme = parseVsCodeThemeFile({
        ...themeValue,
        displayName: label,
        ...(type ? { type } : {}),
      });
      themes.push({ theme, sourceName: path.split("/").at(-1)!, sourcePath: path });
    } catch (cause) {
      options.signal?.throwIfAborted();
      failures.push(
        cause instanceof Error
          ? cause.message
          : msg("A theme in that extension could not be read."),
      );
    }
  }

  if (themes.length === 0) {
    throw new Error(
      failures[0] ?? msg("That extension has no compatible color themes."),
    );
  }
  return { themes, failures };
}

// ---------------------------------------------------------------------------
// Open VSX identity + search
// ---------------------------------------------------------------------------

function shortHash(value: string): string {
  // Two independent FNV-1a passes: stable across sessions, no crypto dependency.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

export function openVsxCollectionId(extensionId: string): string {
  const normalized = `open-vsx:${extensionId.toLowerCase()}`;
  return /^[a-z0-9][a-z0-9.:-]{0,127}$/.test(normalized)
    ? normalized
    : `open-vsx:${shortHash(extensionId)}`;
}

export function openVsxThemeId(extensionId: string, source: string): string {
  return `ovx-theme-${shortHash(`${extensionId.toLowerCase()}:${source}`)}`;
}

function toExtension(result: OpenVsxThemeSearchResult): OpenVsxThemeExtension {
  return { ...result, collectionId: openVsxCollectionId(result.id) };
}

async function withSearchTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error(msg("Open VSX took too long to respond."), { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

/** Search through Burnrate's proxy (the browser never contacts open-vsx.org). */
export async function searchOpenVsxThemes(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<OpenVsxThemeExtension[]> {
  const text = query.trim();
  if (!text) return [];
  return withSearchTimeout(async (signal) => {
    const results = await searchOpenVsxThemeResults(text, { signal });
    return results.map(toExtension);
  }, options.signal);
}

/** Stable ids + light/dark pairing + collection metadata for an extension's themes. */
export function finalizeOpenVsxThemes(
  extension: OpenVsxThemeExtension,
  parsed: ReadonlyArray<ParsedVsixTheme>,
): ReadonlyArray<ThemeDefinition> {
  const occurrences = new Map<string, number>();
  const identities = parsed.map(({ sourcePath }) => {
    const seen = occurrences.get(sourcePath) ?? 0;
    occurrences.set(sourcePath, seen + 1);
    return seen === 0 ? sourcePath : `${sourcePath}\u0000${seen}`;
  });
  const resolved = resolveThemeLabelCollisions(
    parsed.map(({ theme, sourceName }) => ({ theme, sourceName })),
  );
  const withIds = resolved.map((theme, index) => ({
    ...theme,
    id: openVsxThemeId(extension.id, identities[index]!),
  }));
  const paired = pairVsCodeThemes(withIds, {
    pairedId: (light, dark) =>
      openVsxThemeId(extension.id, [light.id, dark.id].sort().join(":")),
  });
  const deduped = resolveThemeLabelCollisions(paired.map((theme) => ({ theme })));
  const collection = { id: extension.collectionId, label: extension.name.slice(0, 48) };
  return deduped.map((theme) => ({ ...theme, collection }));
}

/** Download a VSIX through the proxy, unpack it and return installable themes. */
export async function importOpenVsxThemeExtension(
  extension: OpenVsxThemeExtension,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  const download = await downloadOpenVsxTheme(extension.id, signal);
  signal?.throwIfAborted();
  const { themes, failures } = await parseVsixThemes(download.bytes, {
    signal,
    expected: { id: extension.id, version: extension.version },
  });
  if (failures.length > 0) {
    // An update replaces the whole collection, so a partial read would silently drop variants.
    throw new Error(
      msg("One or more color themes in that extension could not be imported safely."),
    );
  }
  return finalizeOpenVsxThemes(extension, themes);
}

// ---------------------------------------------------------------------------
// Search session controller (debounce + abort; kept out of the component for tests)
// ---------------------------------------------------------------------------

export interface OpenVsxSearchView {
  setResults: (results: ReadonlyArray<OpenVsxThemeExtension> | null) => void;
  setError: (error: string | null) => void;
  setIsSearching: (isSearching: boolean) => void;
}

export interface OpenVsxSearchControllerOptions {
  search?: typeof searchOpenVsxThemes;
  debounceMs?: number;
}

/**
 * Owns one dialog session's Open VSX traffic: the input debounce, the request in flight
 * and which query the shown results belong to. Aborting `signal` (dialog closes) cancels
 * everything, including an install.
 */
export function createOpenVsxSearch(
  view: OpenVsxSearchView,
  signal: AbortSignal,
  options: OpenVsxSearchControllerOptions = {},
) {
  const search = options.search ?? searchOpenVsxThemes;
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  let query = "";
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let install: AbortController | null = null;
  let shownQuery: string | null = null;
  let handledQuery: string | null = null;
  let interrupted = false;

  const abortRequest = () => {
    request?.abort();
    request = null;
  };
  const cancelDebounce = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  };

  const fetchResults = () => {
    abortRequest();
    const controller = new AbortController();
    request = controller;
    const key = query;
    void search(query, { signal: controller.signal })
      .then(
        (results) => {
          if (controller.signal.aborted) return;
          view.setResults(results);
          shownQuery = key;
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          view.setResults(null);
          shownQuery = null;
          view.setError(
            cause instanceof Error && cause.message
              ? cause.message
              : msg("Open VSX search failed."),
          );
        },
      )
      .then(() => {
        if (request !== controller) return;
        request = null;
        view.setIsSearching(false);
      });
  };

  const clear = () => {
    cancelDebounce();
    abortRequest();
    shownQuery = null;
    handledQuery = null;
    view.setResults(null);
    view.setError(null);
    view.setIsSearching(false);
  };

  const settle = () => {
    if (install !== null || signal.aborted || query === "") return;
    const keyChanged = handledQuery !== query;
    if (!keyChanged && !interrupted) return;
    handledQuery = query;
    interrupted = false;
    const shouldFetch = shownQuery !== query;
    if (shouldFetch || keyChanged) view.setError(null);
    view.setIsSearching(shouldFetch);
    if (shouldFetch) fetchResults();
    else abortRequest();
  };

  signal.addEventListener(
    "abort",
    () => {
      cancelDebounce();
      abortRequest();
      install?.abort();
    },
    { once: true },
  );

  return {
    /** A pending debounce avoids hitting Open VSX for text that is no longer visible. */
    setQuery(nextQuery: string) {
      const trimmed = nextQuery.trim();
      if (trimmed === query) return;
      query = trimmed;
      cancelDebounce();
      if (trimmed === "") {
        if (install === null) clear();
        return;
      }
      debounce = setTimeout(() => {
        debounce = null;
        settle();
      }, debounceMs);
    },
    /** Enter, or re-picking the current suggestion, searches again for the shown query. */
    searchNow() {
      if (install !== null || signal.aborted || query === "") return;
      cancelDebounce();
      handledQuery = query;
      interrupted = false;
      view.setError(null);
      view.setIsSearching(true);
      fetchResults();
    },
    beginInstall(): AbortSignal {
      abortRequest();
      install?.abort();
      install = new AbortController();
      interrupted = true;
      view.setIsSearching(false);
      return install.signal;
    },
    endInstall(installSignal: AbortSignal): boolean {
      if (install?.signal !== installSignal) return false;
      install = null;
      if (query === "") clear();
      else if (debounce === null) settle();
      return true;
    },
    dispose() {
      cancelDebounce();
      abortRequest();
      install?.abort();
    },
  };
}
