import { describe, expect, it } from "vitest";

import {
  desktopSwitchBlocked,
  desktopSwitchChecked,
  desktopToggleOutcome,
  testFeedback,
} from "./notificationsLogic";

describe("desktop notifications switch", () => {
  it("persists nothing when a browser denies permission (the stored flag used to become true anyway)", () => {
    expect(desktopToggleOutcome(true, false, "denied")).toEqual({ persist: false, message: "denied" });
    expect(desktopToggleOutcome(true, false, "default")).toEqual({ persist: false, message: "denied" });
    expect(desktopToggleOutcome(true, false, "unsupported")).toEqual({ persist: false, message: "unsupported" });
  });

  it("persists when permission is granted or when running inside the desktop shell", () => {
    expect(desktopToggleOutcome(true, false, "granted")).toEqual({ persist: true, message: null });
    expect(desktopToggleOutcome(true, true, "denied")).toEqual({ persist: true, message: null });
  });

  it("turning it off never needs permission", () => {
    expect(desktopToggleOutcome(false, false, "denied")).toEqual({ persist: false, message: null });
  });

  it("shows on only when the toasts can really appear", () => {
    expect(desktopSwitchChecked(true, false, "granted")).toBe(true);
    expect(desktopSwitchChecked(true, false, "denied")).toBe(false);
    expect(desktopSwitchChecked(true, true, "denied")).toBe(true);
    expect(desktopSwitchChecked(false, true, "granted")).toBe(false);
  });

  it("is blocked only in a browser that cannot be asked again", () => {
    expect(desktopSwitchBlocked(false, "denied")).toBe(true);
    expect(desktopSwitchBlocked(false, "unsupported")).toBe(true);
    expect(desktopSwitchBlocked(false, "default")).toBe(false);
    expect(desktopSwitchBlocked(true, "denied")).toBe(false);
  });
});

describe("testFeedback", () => {
  it("confirms delivery", () => {
    expect(testFeedback("Discord", { ok: true })).toEqual({ kind: "delivered" });
  });

  it("strips the repeated channel name from a failure reason", () => {
    expect(testFeedback("ntfy", { ok: false, message: "ntfy: notification channel responded 404" })).toEqual({
      kind: "failed",
      reason: "notification channel responded 404",
    });
  });

  it("replaces raw network errors with one line about the address", () => {
    expect(testFeedback("ntfy", { ok: false, message: "ntfy: could not resolve host: Der Host ist unbekannt. (os error 11001)" })).toEqual({
      kind: "unreachable",
    });
    expect(testFeedback("Discord", { ok: false, message: "Discord: request timed out" }).kind).toBe("unreachable");
  });

  it("singles out the missing-secret case", () => {
    expect(testFeedback("Webhook", { ok: false, message: "Webhook: No URL saved yet" })).toEqual({
      kind: "needsSecret",
    });
  });

  it("never reports success when the request itself failed", () => {
    expect(testFeedback("ntfy", { error: new Error("Server unreachable") })).toEqual({
      kind: "failed",
      reason: "Server unreachable",
    });
    expect(testFeedback("ntfy", { error: "boom" })).toEqual({ kind: "failed", reason: "" });
    expect(testFeedback("ntfy", { ok: false })).toEqual({ kind: "failed", reason: "" });
  });
});
