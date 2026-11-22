import { msg } from "~/i18n";
import {
  resolveShortcutCommand,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  type ShortcutEventLike,
} from "~/t3-shims/keybindings";
import type { UsageChartMetric } from "./UsageProviderChart";

/** Palette and shell ask the (always mounted) Usage page to switch metric or period. */
export const USAGE_SELECT_EVENT = "burnrate:usage-select";
export type UsageSelectDetail =
  | { readonly type: "usageMetric"; readonly metric: "cost" | "tokens" | "limits" }
  | { readonly type: "usagePeriod"; readonly days: number };

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: msg("Cost"), command: "usage.cost" },
  { value: "tokens", label: msg("Tokens"), command: "usage.tokens" },
  { value: "limits", label: msg("Limits"), command: "usage.limits" },
] as const satisfies readonly {
  value: UsageMetric;
  label: string;
  command: KeybindingCommand;
}[];

export const WINDOW_OPTIONS = [
  { days: 1, label: msg("Past 24h"), command: "usage.period.day" },
  { days: 7, label: msg("7 days"), command: "usage.period.week" },
  { days: 30, label: msg("30 days"), command: "usage.period.month" },
  { days: 90, label: msg("90 days"), command: "usage.period.quarter" },
] as const;

/** Matches T3's guard: shortcuts never fire while typing or inside a non-app modal/popup. */
export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
): KeybindingCommand | null {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest(
        '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal])',
      ))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}
