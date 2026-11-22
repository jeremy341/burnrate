/**
 * General settings. T3-style rows: a short title, one line of helper text and the control on the
 * right. Only the settings a person actually needs to run the app live here; everything else was
 * removed rather than hidden behind an "advanced" or "not applied" section.
 *
 * All values live under `general.*` in the settings contract (docs/CONTRACTS.md section 2). Strings go
 * through `useGT()` / `msg()` from `~/i18n`.
 */
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { msg, useGT } from "~/i18n";
import {
  resetWhenChanged,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "~/settings/layout";
import { DEFAULT_SETTINGS, type GeneralSettings } from "~/settings/schema";
import { useSettings, updateSettings } from "~/settings/store";
import { SECTION_GROUPS, type SectionDef } from "~/settings/types";

/** Options are BCP 47 tags; "system" follows the browser/OS language. */
const LANGUAGES = [
  { value: "system", label: msg("System default") },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
] as const;

const TIMESTAMP_FORMATS = [
  { value: "locale", label: msg("System default") },
  { value: "12-hour", label: msg("12-hour") },
  { value: "24-hour", label: msg("24-hour") },
] as const;

/** Write a partial `general` patch through the settings store (optimistic + debounced PATCH). */
function setGeneral(patch: Partial<GeneralSettings>): void {
  void updateSettings({ general: patch });
}

function General() {
  const gt = useGT();
  const general = useSettings((s) => s.general);
  const defaults = DEFAULT_SETTINGS.general;

  const languageLabel = LANGUAGES.find((l) => l.value === general.language)?.label ?? general.language;
  const timestampLabel =
    TIMESTAMP_FORMATS.find((f) => f.value === general.timestampFormat)?.label ?? general.timestampFormat;

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection desktopOnly title={gt("Startup")}>
        <SettingsSwitchRow
          id="general-launch-at-login"
          title={gt("Launch at login")}
          description={gt("Start Burnrate automatically when you sign in to this computer.")}
          checked={general.launchAtLogin}
          onCheckedChange={(checked) => setGeneral({ launchAtLogin: checked })}
          resetAction={resetWhenChanged(
            general.launchAtLogin !== defaults.launchAtLogin,
            gt("Reset {title} to default", { title: gt("Launch at login") }),
            () => setGeneral({ launchAtLogin: defaults.launchAtLogin }),
          )}
        />
        <SettingsSwitchRow
          id="general-start-minimized"
          title={gt("Start minimized")}
          description={gt("Start without opening the main window.")}
          checked={general.startMinimized}
          onCheckedChange={(checked) => setGeneral({ startMinimized: checked })}
          resetAction={resetWhenChanged(
            general.startMinimized !== defaults.startMinimized,
            gt("Reset {title} to default", { title: gt("Start minimized") }),
            () => setGeneral({ startMinimized: defaults.startMinimized }),
          )}
        />
        <SettingsSwitchRow
          id="general-close-to-tray"
          title={gt("Close to tray")}
          description={gt("Closing the main window keeps Burnrate running in the tray.")}
          checked={general.closeToTray}
          onCheckedChange={(checked) => setGeneral({ closeToTray: checked })}
          resetAction={resetWhenChanged(
            general.closeToTray !== defaults.closeToTray,
            gt("Reset {title} to default", { title: gt("Close to tray") }),
            () => setGeneral({ closeToTray: defaults.closeToTray }),
          )}
        />
      </SettingsSection>

      <SettingsSection title={gt("Display")}>
        <SettingsRow
          id="general-language"
          title={gt("Language")}
          description={gt("Sets how dates and numbers are written. Interface text is English only.")}
          resetAction={resetWhenChanged(
            general.language !== defaults.language,
            gt("Reset {title} to default", { title: gt("Language") }),
            () => setGeneral({ language: defaults.language }),
          )}
          control={(descriptionProps) => (
            <Select
              value={general.language}
              onValueChange={(value) => {
                if (value) setGeneral({ language: value });
              }}
            >
              <SelectTrigger {...descriptionProps} size="sm" className="w-full sm:w-40" aria-label={gt("Language")}>
                <SelectValue>{gt(languageLabel)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false} data-settings-overlay="">
                {LANGUAGES.map((language) => (
                  <SelectItem hideIndicator key={language.value} value={language.value}>
                    {gt(language.label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        />
        <SettingsRow
          id="general-timestamp-format"
          title={gt("Time format")}
          description={gt("System default follows your browser or OS clock preference.")}
          resetAction={resetWhenChanged(
            general.timestampFormat !== defaults.timestampFormat,
            gt("Reset {title} to default", { title: gt("Time format") }),
            () => setGeneral({ timestampFormat: defaults.timestampFormat }),
          )}
          control={(descriptionProps) => (
            <Select
              value={general.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  setGeneral({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger {...descriptionProps} size="sm" className="w-full sm:w-40" aria-label={gt("Time format")}>
                <SelectValue>{gt(timestampLabel)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false} data-settings-overlay="">
                {TIMESTAMP_FORMATS.map((format) => (
                  <SelectItem hideIndicator key={format.value} value={format.value}>
                    {gt(format.label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        />
      </SettingsSection>
    </div>
  );
}

export const section: SectionDef = {
  id: "general",
  title: msg("General"),
  order: 10,
  group: msg(SECTION_GROUPS.preferences),
  Component: General,
};

/** Extra search terms for the flat settings index. */
export const keywords = [
  "startup",
  "login",
  "tray",
  "language",
  "locale",
  "time",
  "clock",
  "format",
  "display",
];
