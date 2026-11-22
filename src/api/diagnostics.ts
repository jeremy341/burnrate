/**
 * Diagnostics and update-check client (docs/CONTRACTS.md, sections "Diagnostics" and "Update check").
 *
 * The server already redacts `lastError`, but a copied report is meant to be pasted into a bug
 * report, so we scrub again here as a defence in depth. No secret value ever leaves this module.
 */
import { request } from "~/api/http";

export interface DiagnosticsProvider {
  readonly id: string;
  /** Wall-clock time of the last probe in milliseconds, or null when it never ran. */
  readonly lastProbeMs: number | null;
  /** Already redacted by the server; scrubbed again before it is copied. */
  readonly lastError: string | null;
}

export interface DiagnosticsReport {
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly dataDir: string;
  readonly uptimeSec: number;
  /** Resident set size when the platform exposes it cheaply. */
  readonly memoryMB?: number | null;
  readonly settingsSizeBytes: number;
  /** Cache name -> size in bytes (the exact keys are server-defined). */
  readonly cacheSizes?: Readonly<Record<string, number | null | undefined>>;
  readonly providers: readonly DiagnosticsProvider[];
}

export interface UpdateCheckResult {
  readonly current: string;
  readonly latest: string;
  /** Release page, https only on the server side. */
  readonly url: string;
  readonly newer: boolean;
}

/** GET /api/diagnostics — version, data dir, sizes and per-provider probe timings. */
export function getDiagnostics(): Promise<DiagnosticsReport> {
  return request<DiagnosticsReport>("/api/diagnostics");
}

/** GET /api/update-check — opt-in through general.checkForUpdates (403 "disabled" when off). */
export function checkForUpdates(): Promise<UpdateCheckResult> {
  return request<UpdateCheckResult>("/api/update-check");
}

/** Hide the account segment of a home path (both Windows and POSIX) without hiding the rest. */
export function maskHomePath(text: string): string {
  return text.replace(
    /((?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/))[^\\/\s]+/g,
    (_match, prefix: string) => `${prefix}[redacted]`,
  );
}

/**
 * Remove anything that looks like a credential from arbitrary diagnostic text.
 * Kept intentionally simple and closed: no evaluation, no network, no external state.
 */
export function redactDiagnosticsText(text: string): string {
  return text
    .replace(
      /\b(?:sk-ant-admin|sk-ant|sk-or-v1|sk-|gsk_|xai-|AIza|ghp_|gho_|github_pat_|pplx-|kimi-)[A-Za-z0-9._-]{6,}/g,
      "[redacted key]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted token]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[redacted]")
    .replace(/(Authorization|x-api-key|api-key|Cookie|Set-Cookie)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** T3-style probe duration: sub-second values stay in ms, larger ones in s. */
export function formatProbeDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "n/a";
  const rounded = Math.round(ms);
  if (rounded < 1_000) return `${rounded} ms`;
  return `${(rounded / 1_000).toFixed(rounded >= 10_000 ? 1 : 2).replace(/\.0+$/, "")} s`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "n/a";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/** Build a plain-text, fully redacted report suitable for an issue or support request. */
export function formatDiagnosticsReport(report: DiagnosticsReport): string {
  const lines: string[] = [
    "Burnrate diagnostics",
    `Version: ${report.version}`,
    `Platform: ${report.os} (${report.arch})`,
    `Uptime: ${formatUptime(report.uptimeSec)}`,
    `Memory (RSS): ${report.memoryMB == null ? "unavailable" : `${Math.round(report.memoryMB)} MB`}`,
    `Data directory: ${report.dataDir}`,
    `Settings size: ${formatBytes(report.settingsSizeBytes)}`,
  ];

  const caches = report.cacheSizes ?? {};
  for (const [name, bytes] of Object.entries(caches)) {
    if (typeof bytes === "number") lines.push(`Cache ${name}: ${formatBytes(bytes)}`);
  }

  const providers = Array.isArray(report.providers) ? report.providers : [];
  lines.push("Providers:");
  if (providers.length === 0) {
    lines.push("  (none)");
  } else {
    for (const provider of providers) {
      const probe = `probe ${formatProbeDuration(provider.lastProbeMs)}`;
      lines.push(`  - ${provider.id}: ${probe}${provider.lastError ? `: ${provider.lastError}` : ""}`);
    }
  }

  return redactDiagnosticsText(maskHomePath(lines.join("\n")));
}
