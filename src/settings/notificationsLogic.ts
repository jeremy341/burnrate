/**
 * Pure rules for the Notifications section, kept free of React and of `Notification` so they can be unit
 * tested in node. The component feeds them the live environment.
 */
export type DesktopPermission = NotificationPermission | "unsupported";

/**
 * Whether the "Desktop notifications" switch shows as on. The desktop app raises native toasts from its
 * own shell, so the webview's `Notification.permission` is irrelevant there. A browser tab needs a granted
 * permission, otherwise a stored `true` would claim toasts that can never appear.
 */
export function desktopSwitchChecked(stored: boolean, inDesktopShell: boolean, permission: DesktopPermission): boolean {
  if (!stored) return false;
  return inDesktopShell || permission === "granted";
}

/** A browser that has said no cannot be asked again from a switch; the user has to change it in site settings. */
export function desktopSwitchBlocked(inDesktopShell: boolean, permission: DesktopPermission): boolean {
  return !inDesktopShell && (permission === "denied" || permission === "unsupported");
}

/**
 * What flipping the switch should do. Turning it on in a browser must wait for the permission answer and
 * only persist `true` when it was granted; persisting first (the old behaviour) left the server with
 * `desktop: true` while the switch showed off.
 */
export function desktopToggleOutcome(
  checked: boolean,
  inDesktopShell: boolean,
  permissionAfterRequest: DesktopPermission,
): { persist: boolean; message: "granted" | "denied" | "unsupported" | null } {
  if (!checked) return { persist: false, message: null };
  if (inDesktopShell) return { persist: true, message: null };
  if (permissionAfterRequest === "granted") return { persist: true, message: null };
  return { persist: false, message: permissionAfterRequest === "unsupported" ? "unsupported" : "denied" };
}

/** What the inline feedback next to a channel's "Send test" button reports (the page words it). */
export type TestFeedback =
  | { readonly kind: "delivered" }
  | { readonly kind: "needsSecret" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Turns the server's answer (or a thrown error) into a feedback kind. The server reports
 * `"<Channel>: <reason>"` for each failure; the row already names the channel, so strip it, and
 * single out the one case a user can fix themselves.
 */
export function testFeedback(
  label: string,
  outcome: { readonly ok: boolean; readonly message?: string } | { readonly error: unknown },
): TestFeedback {
  if ("error" in outcome) {
    return { kind: "failed", reason: outcome.error instanceof Error ? outcome.error.message.trim() : "" };
  }
  if (outcome.ok) return { kind: "delivered" };
  const prefix = `${label}:`;
  const raw = (outcome.message ?? "").trim();
  const reason = raw.toLowerCase().startsWith(prefix.toLowerCase()) ? raw.slice(prefix.length).trim() : raw;
  if (/^no url saved/i.test(reason)) return { kind: "needsSecret" };
  // OS error text is localised and means nothing to a user; "wrong address" is what it says.
  if (/resolve host|os error|connection (refused|reset)|timed out|timeout|unreachable|dns|not allowed|blocked/i.test(reason)) {
    return { kind: "unreachable" };
  }
  return { kind: "failed", reason };
}
