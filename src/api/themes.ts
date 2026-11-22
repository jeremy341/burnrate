/**
 * Client for the Open VSX theme proxy (docs/CONTRACTS.md section 3, server route in
 * `server-rs/src/routes/themes_api.rs`).
 *
 * The proxy is opt-in (`advanced.experimental.openVsx`) and answers
 * `403 {"error":"disabled"}` until the user turns it on, so every caller must be able
 * to render that state. Search results are already sanitised by the server; this
 * module still re-validates ids, urls and numbers because they cross the network.
 *
 * Search: `GET /api/themes/openvsx/search?q=` ->
 *   `{ "extensions": [{ id, publisher, extensionName, name, description,
 *                       version, downloadCount, iconUrl }] }` where `id` is
 *   `"<publisher>.<extensionName>"`.
 * Download: `GET /api/themes/openvsx/download?id=<id>` -> raw VSIX bytes
 *   (the server caps them at 5 MiB; the client enforces the same cap while reading).
 */
import { msg } from "~/i18n";

import { ApiError } from "./http";

/** Mirrors `MAX_DOWNLOAD_BYTES` in `server-rs/src/themes.rs`. */
export const OPENVSX_MAX_VSIX_BYTES = 5 * 1024 * 1024;
/** Mirrors `MAX_QUERY_LEN` in `server-rs/src/routes/themes_api.rs`. */
export const OPENVSX_MAX_QUERY_LENGTH = 128;

/** One sanitised search hit. `iconUrl` is null unless it is an https open-vsx.org url. */
export interface OpenVsxThemeSearchResult {
  id: string;
  publisher: string;
  extensionName: string;
  name: string;
  description: string;
  version: string;
  downloadCount: number;
  iconUrl: string | null;
}

export interface OpenVsxThemeDownload {
  bytes: Uint8Array;
  filename: string;
  version: string;
}

/** The server (or a build without the proxy route) refuses until the opt-in is on. */
export class OpenVsxDisabledError extends ApiError {
  constructor() {
    super(
      msg("Open VSX search is off. Turn it on in Settings > Advanced to search open-vsx.org."),
      403,
      "disabled",
    );
    this.name = "OpenVsxDisabledError";
  }
}

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}\.[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const DOWNLOAD_FILENAME = /^[A-Za-z0-9._-]{1,180}$/;

/** Stricter than the server's check on purpose: no dots, slashes or escapes inside a part. */
export function isValidExtensionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && EXTENSION_ID.test(value);
}

function trustedIconUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (host !== "open-vsx.org" && !host.endsWith(".open-vsx.org")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Accept only the documented fields and only values the UI can render safely. */
function sanitizeSearchResult(value: unknown): OpenVsxThemeSearchResult | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (!isValidExtensionId(item.id)) return null;
  const [publisher, extensionName] = item.id.split(".") as [string, string];
  const extensionFallback = asString(item.extensionName, extensionName);
  const displayName = asString(item.name).trim() || extensionFallback;
  const downloadCount = typeof item.downloadCount === "number" && Number.isFinite(item.downloadCount)
    ? Math.max(0, Math.trunc(item.downloadCount))
    : 0;
  return {
    id: item.id,
    publisher: asString(item.publisher, publisher),
    extensionName: extensionFallback,
    name: displayName,
    description: asString(item.description),
    version: asString(item.version),
    downloadCount,
    iconUrl: trustedIconUrl(item.iconUrl),
  };
}

function invalidQueryError(): Error {
  return new ApiError(
    msg("Enter a search term of {max} characters or fewer.", { max: OPENVSX_MAX_QUERY_LENGTH }),
    400,
    "invalid query",
  );
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "string" && error) return error;
    }
  } catch {
    // Non-JSON failures still become an ApiError with the HTTP status.
  }
  return null;
}

async function failure(response: Response, action: "search" | "download"): Promise<Error> {
  const code = await errorCode(response);
  if (response.status === 403) return new OpenVsxDisabledError();
  if (response.status === 400) {
    return new ApiError(
      action === "search" ? invalidQueryError().message : msg("That theme id is not valid."),
      400,
      code,
    );
  }
  if (response.status === 413) {
    return new ApiError(
      msg("That theme package is too large to import (the limit is 5 MB)."),
      413,
      code,
    );
  }
  if (response.status === 404) {
    return new ApiError(
      action === "search"
        ? msg("Open VSX search is not available in this build.")
        : msg("That theme package is no longer available on Open VSX."),
      404,
      code,
    );
  }
  return new ApiError(
    action === "search"
      ? msg("Open VSX search is unavailable right now. Try again later.")
      : msg("That theme could not be downloaded from Open VSX. Try again later."),
    response.status,
    code,
  );
}

/** `GET /api/themes/openvsx/search?q=` -> sanitised hits (server-capped at 16). */
export async function searchOpenVsxThemes(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<OpenVsxThemeSearchResult[]> {
  const searchText = query.trim();
  if (!searchText) return [];
  if (searchText.length > OPENVSX_MAX_QUERY_LENGTH) throw invalidQueryError();

  const response = await fetch(
    `/api/themes/openvsx/search?q=${encodeURIComponent(searchText)}`,
    { headers: { "X-Burnrate": "1" }, signal: options.signal ?? null },
  );
  if (!response.ok) throw await failure(response, "search");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      msg("Open VSX returned an unreadable search response."),
      response.status,
      null,
    );
  }
  const list =
    typeof payload === "object" && payload !== null
      ? (payload as { extensions?: unknown }).extensions
      : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map(sanitizeSearchResult)
    .filter((item): item is OpenVsxThemeSearchResult => item !== null)
    .slice(0, 16);
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new ApiError(
      msg("That theme package is too large to import (the limit is 5 MB)."),
      413,
      "too large",
    );
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) throw tooLarge();
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw tooLarge();
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw tooLarge();
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

function downloadFilename(response: Response, id: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/i.exec(header) ?? /filename=([^\s;]+)/i.exec(header);
  const name = match?.[1];
  if (name && DOWNLOAD_FILENAME.test(name)) return name;
  return `${id.split(".").pop() ?? "theme"}.vsix`;
}

/** `GET /api/themes/openvsx/download?id=` -> raw VSIX bytes (never more than 5 MiB). */
export async function downloadOpenVsxTheme(
  id: string,
  signal?: AbortSignal,
): Promise<OpenVsxThemeDownload> {
  if (!isValidExtensionId(id)) {
    throw new ApiError(msg("That theme id is not valid."), 400, "invalid id");
  }
  const response = await fetch(
    `/api/themes/openvsx/download?id=${encodeURIComponent(id)}`,
    { headers: { "X-Burnrate": "1" }, signal: signal ?? null },
  );
  if (!response.ok) throw await failure(response, "download");
  const bytes = await readCapped(response, OPENVSX_MAX_VSIX_BYTES);
  const filename = downloadFilename(response, id);
  const version = /-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.vsix$/i.exec(filename)?.[1] ?? "";
  return { bytes, filename, version };
}
