import { msg } from "~/i18n";
import type { UsageChartMetric } from "./UsageProviderChart";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: msg("Cost"), command: "usage.cost" },
  { value: "tokens", label: msg("Tokens"), command: "usage.tokens" },
  { value: "limits", label: msg("Limits"), command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: string }[];

export const WINDOW_OPTIONS = [
  { days: 1, label: msg("Past 24h"), command: "usage.period.day" },
  { days: 7, label: msg("7 days"), command: "usage.period.week" },
  { days: 30, label: msg("30 days"), command: "usage.period.month" },
  { days: 90, label: msg("90 days"), command: "usage.period.quarter" },
] as const;
