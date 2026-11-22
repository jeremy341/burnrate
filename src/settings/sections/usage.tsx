import { SlidersHorizontalIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";

import { cachedUsage, fetchUsage } from "~/api/usage";
import { BudgetEditor } from "~/components/settings/BudgetEditor";
import { SettingsNumberField } from "~/components/settings/SettingsNumberField";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { msg, useGT } from "~/i18n";
import { makeWindow } from "~/shared/usageFormat";
import {
  resetWhenChanged,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "~/settings/layout";
import { DEFAULT_SETTINGS, type SettingsPatch, type UsageSettings } from "~/settings/schema";
import { updateSettings, useSettings } from "~/settings/store";
import { applyUsageDefaults, readHideEmptyProviders, setHideEmptyProviders } from "../usageDefaults";
import { SECTION_GROUPS, type SectionDef } from "../types";

/** The custom-prices dialog (also reachable from a model's detail on Usage), loaded only when opened. */
const PriceOverridesDialog = lazy(() =>
  import("~/components/usage/UsagePriceOverrides").then((module) => ({
    default: module.UsagePriceOverrides,
  })),
);

/**
 * The editor can suggest model IDs without a Usage page. Reuse the cached 90-day answer or fetch it once.
 */
function ModelPriceDialog({ onClose, returnFocusRef }: {
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [window] = useState(() => makeWindow(90));
  const [summary, setSummary] = useState(() => cachedUsage(window) ?? null);
  useEffect(() => {
    if (summary !== null) return;
    const controller = new AbortController();
    fetchUsage(window, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setSummary(response);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [summary, window]);
  return (
    <PriceOverridesDialog
      modelSuggestions={summary?.buckets.map((bucket) => bucket.model)}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}

interface Option {
  readonly value: string;
  readonly label: string;
}

/** T3's `usageShortcuts.ts` metric and window options, verbatim. */
const METRIC_OPTIONS: readonly Option[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
];

const PERIOD_OPTIONS: readonly Option[] = [
  { value: "today", label: "Past 24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

/** Kept only because the settings-page test imports them; cost figures are always USD, like T3. */
export const CURRENCY_PATTERN = /^[A-Z]{3,8}$/;

export function normalizeCurrency(raw: string): string {
  return raw.trim().toUpperCase();
}

function EnumSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly Option[];
  onChange: (value: string | null) => void;
  label: string;
}) {
  const gt = useGT();
  return (
    <Select value={value} onValueChange={(next) => onChange(next)}>
      <SelectTrigger size="sm" aria-label={label} className="w-full sm:w-40">
        <SelectValue>{gt(options.find((option) => option.value === value)?.label ?? value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {gt(option.label)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function UsageSettings() {
  const gt = useGT();
  const usage = useSettings((settings) => settings.usage);
  const [error, setError] = useState("");
  const [hideEmpty, setHideEmpty] = useState(readHideEmptyProviders);
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const editPricesRef = useRef<HTMLButtonElement>(null);

  function setUsage<K extends keyof UsageSettings>(key: K, value: UsageSettings[K]): void {
    setError("");
    const patch = { usage: { [key]: value } } as SettingsPatch;
    // The Usage page reads its own remembered view/period; carry these two across so they take effect.
    if (key === "defaultView" || key === "defaultPeriod") {
      applyUsageDefaults({ defaultView: usage.defaultView, defaultPeriod: usage.defaultPeriod, [key]: value });
    }
    void updateSettings(patch).catch((cause: unknown) => {
      setError(
        gt("Could not save setting: {error}", {
          error: cause instanceof Error ? cause.message : gt("Unknown error"),
        }),
      );
    });
  }

  /** Reset affordance shared by every row: an icon beside the title, present only when changed. */
  function resetFor<K extends keyof UsageSettings>(key: K, label: string) {
    return resetWhenChanged(
      usage[key] !== DEFAULT_SETTINGS.usage[key],
      gt("Reset {label} to default", { label }),
      () => setUsage(key, DEFAULT_SETTINGS.usage[key]),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsNotice kind="error">{error}</SettingsNotice>

      <SettingsSection title={gt("Defaults")} description={gt("What the Usage view shows when it opens.")}>
        <SettingsRow
          id="usage-default-view"
          title={gt("Default metric")}
          description={gt("Which metric the Usage page opens on.")}
          resetAction={resetFor("defaultView", gt("Default metric"))}
          control={
            <EnumSelect
              value={usage.defaultView}
              options={METRIC_OPTIONS}
              label={gt("Default metric")}
              onChange={(value) => {
                if (value !== null) setUsage("defaultView", value as UsageSettings["defaultView"]);
              }}
            />
          }
        />
        <SettingsRow
          id="usage-default-period"
          title={gt("Default period")}
          description={gt("Which time range cost and tokens start on.")}
          resetAction={resetFor("defaultPeriod", gt("Default period"))}
          control={
            <EnumSelect
              value={usage.defaultPeriod}
              options={PERIOD_OPTIONS}
              label={gt("Default period")}
              onChange={(value) => {
                if (value !== null) setUsage("defaultPeriod", value as UsageSettings["defaultPeriod"]);
              }}
            />
          }
        />
        <SettingsSwitchRow
          id="usage-hide-empty"
          title={gt("Hide empty providers")}
          description={gt("Skip providers with no usage on the Usage page.")}
          keywords={["empty", "hidden", "providers"]}
          checked={hideEmpty}
          onCheckedChange={(checked) => {
            setHideEmpty(checked);
            setHideEmptyProviders(checked);
          }}
        />
      </SettingsSection>

      <SettingsSection
        title={gt("Limits")}
        description={gt("How often Burnrate re-reads your limits.")}
      >
        <SettingsRow
          id="usage-refresh-interval"
          title={gt("Refresh interval")}
          description={gt("Seconds between automatic refreshes. 30 to 86,400.")}
          resetAction={resetFor("refreshIntervalSec", gt("Refresh interval"))}
          control={
            <SettingsNumberField
              value={usage.refreshIntervalSec}
              min={30}
              max={86400}
              ariaLabel={gt("Refresh interval in seconds")}
              onCommit={(seconds) => setUsage("refreshIntervalSec", seconds)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={gt("Cost")}>
        <SettingsRow
          id="usage-custom-prices"
          title={gt("Model prices")}
          description={gt("Override the price per model that Burnrate uses to work out cost.")}
          control={
            <Button
              ref={editPricesRef}
              size="sm"
              variant="outline"
              aria-haspopup="dialog"
              onClick={() => setPriceDialogOpen(true)}
            >
              <SlidersHorizontalIcon aria-hidden />
              {gt("Edit model prices")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        id="usage-budgets"
        title={gt("Budgets")}
        description={gt("Monthly spend caps for API keys that report no usage of their own.")}
      >
        <BudgetEditor />
      </SettingsSection>

      {priceDialogOpen ? (
        <Suspense fallback={<p role="status" className="sr-only">{gt("Opening model prices…")}</p>}>
          <ModelPriceDialog returnFocusRef={editPricesRef} onClose={() => setPriceDialogOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

export const section: SectionDef = {
  id: "usage",
  title: msg("Usage"),
  order: 30,
  group: msg(SECTION_GROUPS.preferences),
  Component: UsageSettings,
};

/** Picked up by the settings search index when it reads section modules. */
export const keywords = [
  "usage",
  "cost",
  "tokens",
  "limits",
  "refresh",
  "budget",
  "budgets",
  "model prices",
  "prices",
  "pricing",
  "alias",
  "empty providers",
];
