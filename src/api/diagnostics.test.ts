import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDiagnosticsReport,
  formatProbeDuration,
  formatUptime,
  maskHomePath,
  redactDiagnosticsText,
  type DiagnosticsReport,
} from "./diagnostics";

describe("maskHomePath", () => {
  it("hides the account segment of Windows and POSIX home paths", () => {
    expect(maskHomePath("C:\\Users\\alice\\AppData\\Roaming\\burnrate")).toBe(
      "C:\\Users\\[redacted]\\AppData\\Roaming\\burnrate",
    );
    expect(maskHomePath("/Users/alice/Library/Application Support/burnrate")).toBe(
      "/Users/[redacted]/Library/Application Support/burnrate",
    );
    expect(maskHomePath("/home/bob/.config/burnrate")).toBe("/home/[redacted]/.config/burnrate");
  });

  it("masks every home path in a multi-line report", () => {
    const text = "data: /Users/alice/.burnrate\ncache: /home/bob/.cache";
    expect(maskHomePath(text)).toBe("data: /Users/[redacted]/.burnrate\ncache: /home/[redacted]/.cache");
  });

  it("leaves paths that are not home directories alone", () => {
    expect(maskHomePath("C:\\Program Files\\Burnrate")).toBe("C:\\Program Files\\Burnrate");
    expect(maskHomePath("/var/lib/burnrate")).toBe("/var/lib/burnrate");
  });
});

describe("redactDiagnosticsText", () => {
  it("redacts provider API keys", () => {
    const text = [
      "anthropic sk-ant-api03-AbCdEf0123456789",
      "openrouter sk-or-v1-AbCdEf0123456789",
      "openai sk-proj-AbCdEf0123456789",
      "google AIzaSyAbCdEf0123456789",
      "github ghp_AbCdEf0123456789",
      "xai xai-AbCdEf0123456789",
      "kimi kimi-AbCdEf0123456789",
    ].join("\n");
    const redacted = redactDiagnosticsText(text);
    expect(redacted).not.toMatch(/sk-ant|sk-or-v1|sk-proj|AIza|ghp_|xai-|kimi-/);
    expect(redacted.match(/\[redacted key]/g)).toHaveLength(7);
  });

  it("redacts Bearer tokens", () => {
    const redacted = redactDiagnosticsText("Request failed with Bearer abcdefgh12345678");
    expect(redacted).not.toContain("abcdefgh12345678");
    expect(redacted).toContain("[redacted]");
  });

  it("redacts JWTs and long hex/base64 blobs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(redactDiagnosticsText(jwt)).toBe("[redacted token]");
    expect(redactDiagnosticsText("hash 0123456789abcdef0123456789abcdef")).toBe("hash [redacted]");
    expect(redactDiagnosticsText(`blob ${"A".repeat(40)}`)).toBe("blob [redacted]");
  });

  it("redacts credential headers while keeping the header name", () => {
    expect(redactDiagnosticsText("x-api-key: plain-value")).toBe("x-api-key: [redacted]");
    expect(redactDiagnosticsText("Authorization: Bearer abcdefgh123")).not.toContain("abcdefgh123");
    expect(redactDiagnosticsText("Set-Cookie: session=abc123; Path=/")).not.toContain("session=abc123");
  });

  it("leaves ordinary diagnostic text untouched", () => {
    const text = "Version: 1.2.3\nPlatform: win32 (x64)\nprobe 42 ms";
    expect(redactDiagnosticsText(text)).toBe(text);
    expect(redactDiagnosticsText("short abc123 hash")).toBe("short abc123 hash");
  });
});

describe("formatBytes", () => {
  it("formats with binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("treats missing, non-finite and non-positive values as zero", () => {
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatProbeDuration", () => {
  it("uses milliseconds below one second", () => {
    expect(formatProbeDuration(0)).toBe("0 ms");
    expect(formatProbeDuration(12.4)).toBe("12 ms");
    expect(formatProbeDuration(999)).toBe("999 ms");
  });

  it("switches to seconds at one second and trims trailing zeros", () => {
    expect(formatProbeDuration(1000)).toBe("1 s");
    expect(formatProbeDuration(1500)).toBe("1.50 s");
    expect(formatProbeDuration(9999)).toBe("10 s");
    expect(formatProbeDuration(12_345)).toBe("12.3 s");
  });

  it("renders unavailable values as an em dash", () => {
    expect(formatProbeDuration(null)).toBe("n/a");
    expect(formatProbeDuration(undefined)).toBe("n/a");
    expect(formatProbeDuration(-1)).toBe("n/a");
    expect(formatProbeDuration(Number.NaN)).toBe("n/a");
  });
});

describe("formatUptime", () => {
  it("picks the largest useful pair of units", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(3600)).toBe("1h 00m");
    expect(formatUptime(3661)).toBe("1h 01m");
    expect(formatUptime(90_061)).toBe("1d 1h");
  });

  it("renders unavailable values as an em dash", () => {
    expect(formatUptime(null)).toBe("n/a");
    expect(formatUptime(undefined)).toBe("n/a");
    expect(formatUptime(-10)).toBe("n/a");
    expect(formatUptime(Number.NaN)).toBe("n/a");
  });
});

describe("formatDiagnosticsReport", () => {
  const secret = "sk-ant-api03-SuperSecretValue123456";
  const accessToken = "abcdefgh12345678";
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";

  const report: DiagnosticsReport = {
    version: "1.2.3",
    os: "win32",
    arch: "x64",
    dataDir: "C:\\Users\\alice\\AppData\\Roaming\\burnrate",
    uptimeSec: 90_061,
    memoryMB: 127.6,
    settingsSizeBytes: 2048,
    cacheSizes: { http: 1536, history: null },
    providers: [
      {
        id: "anthropic",
        lastProbeMs: 1500,
        lastError: `401 on ${secret} (Authorization: Bearer ${accessToken}) ${jwt}`,
      },
      { id: "openai", lastProbeMs: null, lastError: null },
    ],
  };

  it("summarises version, platform, sizes and providers", () => {
    const text = formatDiagnosticsReport(report);
    expect(text).toContain("Burnrate diagnostics");
    expect(text).toContain("Version: 1.2.3");
    expect(text).toContain("Platform: win32 (x64)");
    expect(text).toContain("Uptime: 1d 1h");
    expect(text).toContain("Memory (RSS): 128 MB");
    expect(text).toContain("Settings size: 2.0 KB");
    expect(text).toContain("Cache http: 1.5 KB");
    expect(text).not.toContain("Cache history");
    expect(text).toContain("  - anthropic: probe 1.50 s: 401");
    expect(text).toContain("  - openai: probe n/a");
  });

  it("never leaks secrets or the account name", () => {
    const text = formatDiagnosticsReport(report);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(accessToken);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain("alice");
    expect(text).toContain("C:\\Users\\[redacted]\\AppData\\Roaming\\burnrate");
  });

  it("handles missing optional fields", () => {
    const text = formatDiagnosticsReport({
      version: "0.1.0",
      os: "linux",
      arch: "arm64",
      dataDir: "/home/bob/.burnrate",
      uptimeSec: 5,
      memoryMB: null,
      settingsSizeBytes: 0,
      providers: [],
    });
    expect(text).toContain("Memory (RSS): unavailable");
    expect(text).toContain("Settings size: 0 B");
    expect(text).toContain("/home/[redacted]/.burnrate");
    expect(text).toContain("Providers:\n  (none)");
  });
});
