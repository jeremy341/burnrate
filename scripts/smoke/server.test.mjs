import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SERVER_BINARY,
  isolatedServerEnv,
  resolveServerExe,
  resolveWebDir,
} from "./server.mjs";

const ROOT = path.resolve("C:/repo");

describe("resolveServerExe", () => {
  it("prefers BURNRATE_SERVER_EXE", () => {
    const expected = path.resolve(ROOT, "custom/burnrate-server.exe");
    const exe = resolveServerExe({
      root: ROOT,
      env: { BURNRATE_SERVER_EXE: "custom/burnrate-server.exe" },
      exists: (candidate) => candidate === expected,
    });
    expect(exe).toBe(expected);
  });

  it("checks CARGO_TARGET_DIR release before debug", () => {
    const target = path.join(ROOT, "cargo-target");
    const release = path.join(target, "release", SERVER_BINARY);
    const debug = path.join(target, "debug", SERVER_BINARY);
    const find = (existing) =>
      resolveServerExe({
        root: ROOT,
        env: { CARGO_TARGET_DIR: target },
        exists: (candidate) => existing.includes(candidate),
      });
    expect(find([release, debug])).toBe(release);
    expect(find([debug])).toBe(debug);
  });

  it("falls back to server-rs/target and returns null when nothing exists", () => {
    const debug = path.join(ROOT, "server-rs", "target", "debug", SERVER_BINARY);
    expect(
      resolveServerExe({ root: ROOT, env: {}, exists: (candidate) => candidate === debug }),
    ).toBe(debug);
    expect(resolveServerExe({ root: ROOT, env: {}, exists: () => false })).toBeNull();
  });
});

describe("resolveWebDir", () => {
  it("uses BURNRATE_WEB when index.html exists", () => {
    const expected = path.resolve(ROOT, "custom-web");
    const web = resolveWebDir({
      root: ROOT,
      env: { BURNRATE_WEB: "custom-web" },
      exists: (candidate) => candidate === path.join(expected, "index.html"),
    });
    expect(web).toBe(expected);
  });

  it("defaults to dist/web and rejects a directory without index.html", () => {
    expect(
      resolveWebDir({
        root: ROOT,
        env: {},
        exists: (candidate) => candidate === path.join(ROOT, "dist", "web", "index.html"),
      }),
    ).toBe(path.join(ROOT, "dist", "web"));
    expect(resolveWebDir({ root: ROOT, env: {}, exists: () => false })).toBeNull();
  });
});

describe("isolatedServerEnv", () => {
  it("redirects every login/config location into the throwaway home", () => {
    const env = isolatedServerEnv({
      home: "C:/tmp/home",
      port: 13_850,
      dataDir: "C:/tmp/data",
      webDir: "C:/repo/dist/web",
      env: { PATH: "keep-me", USERPROFILE: "C:/Users/real", CLAUDE_CONFIG_DIR: "C:/Users/real/.claude" },
    });
    const home = path.resolve("C:/tmp/home");
    expect(env.PATH).toBe("keep-me");
    expect(env.USERPROFILE).toBe(home);
    expect(env.HOME).toBe(home);
    expect(env.APPDATA).toBe(path.join(home, "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(path.join(home, "AppData", "Local"));
    expect(env.XDG_CONFIG_HOME).toBe(path.join(home, ".config"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, ".claude"));
    expect(env.CODEX_HOME).toBe(path.join(home, ".codex"));
    expect(env.BURNRATE_PORT).toBe("13850");
    expect(env.BURNRATE_DATA).toBe(path.resolve("C:/tmp/data"));
    expect(env.BURNRATE_WEB).toBe(path.resolve("C:/repo/dist/web"));
  });

  it("does not mutate the incoming environment", () => {
    const source = { USERPROFILE: "C:/Users/real" };
    isolatedServerEnv({
      home: "C:/tmp/home",
      port: 1,
      dataDir: "C:/tmp/data",
      webDir: "C:/web",
      env: source,
    });
    expect(source.USERPROFILE).toBe("C:/Users/real");
    expect(source.BURNRATE_PORT).toBeUndefined();
  });
});
