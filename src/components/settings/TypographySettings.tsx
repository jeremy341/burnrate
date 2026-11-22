/**
 * Settings → Appearance → Typography (trimmed from T3's `TypographySettings`).
 *
 * Burnrate exposes two families: the interface font and the monospace font.
 * Font sizes, the prompt/composer font and the terminal font are deliberately
 * omitted; the settings contract only has `appearance.fontFamily` and
 * `appearance.monoFontFamily` (docs/CONTRACTS.md section 2).
 */
import { useEffect, useState } from "react";

import {
  applyAppearanceFontVariables,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  resolveDefaultFamilyLabel,
} from "~/appearanceFonts";
import { FontFamilyPicker } from "~/components/settings/FontFamilyPicker";
import { InterfaceFontPreview, MonoFontPreview } from "~/components/settings/SettingsFontPreviews";
import { useGT } from "~/i18n";
import { SettingResetButton, SettingsRow, SettingsSection } from "~/settings/layout";
import { updateSettings, useSettings } from "~/settings/store";

function setAppearanceFont(
  key: "fontFamily" | "monoFontFamily",
  family: string | null,
): void {
  void updateSettings({ appearance: { [key]: family } });
}

export function TypographySettings() {
  const gt = useGT();
  const appearance = useSettings((settings) => settings.appearance);
  // Resolving the default family label measures text in a probe element, i.e. it mutates the DOM.
  // That must not happen while rendering, so start from the fallback labels and refine in an effect.
  const [defaults, setDefaults] = useState(() => ({
    sans: gt("System default"),
    mono: gt("System monospace"),
  }));
  useEffect(() => {
    const sans = resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK);
    const mono = resolveDefaultFamilyLabel(DEFAULT_MONO_FONT_STACK);
    setDefaults((current) => ({ sans: sans ?? current.sans, mono: mono ?? current.mono }));
  }, []);

  // `appearanceFonts.ts` also follows the store, but applying here makes the
  // previews update immediately even if the module-level bridge was stopped.
  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, appearance);
  }, [appearance.fontFamily, appearance.monoFontFamily]);

  return (
    <SettingsSection id="typography" title={gt("Typography")}>
      <SettingsRow
        id="interface-font"
        title={gt("Interface font")}
        description={gt("Everything outside code blocks and the terminal.")}
        resetAction={
          appearance.fontFamily !== null ? (
            <SettingResetButton
              ariaLabel={gt("Reset interface font to default")}
              onClick={() => setAppearanceFont("fontFamily", null)}
            />
          ) : null
        }
        control={({ "aria-describedby": descriptionId }) => (
          <div className="w-full sm:w-56">
            <FontFamilyPicker
              id="interface-font-picker"
              ariaLabel={gt("Interface font family")}
              descriptionId={descriptionId}
              defaultFamily={defaults.sans}
              value={appearance.fontFamily}
              onValueChange={(family) => setAppearanceFont("fontFamily", family)}
            />
          </div>
        )}
      >
        <InterfaceFontPreview family={appearance.fontFamily} />
      </SettingsRow>

      <SettingsRow
        id="mono-font"
        title={gt("Monospace font")}
        description={gt("Numbers, token counts, and aligned columns.")}
        resetAction={
          appearance.monoFontFamily !== null ? (
            <SettingResetButton
              ariaLabel={gt("Reset monospace font to default")}
              onClick={() => setAppearanceFont("monoFontFamily", null)}
            />
          ) : null
        }
        control={({ "aria-describedby": descriptionId }) => (
          <div className="w-full sm:w-56">
            <FontFamilyPicker
              id="mono-font-picker"
              ariaLabel={gt("Monospace font family")}
              descriptionId={descriptionId}
              defaultFamily={defaults.mono}
              defaultStack={DEFAULT_MONO_FONT_STACK}
              requireMonospace
              value={appearance.monoFontFamily}
              onValueChange={(family) => setAppearanceFont("monoFontFamily", family)}
            />
          </div>
        )}
      >
        <MonoFontPreview family={appearance.monoFontFamily} />
      </SettingsRow>
    </SettingsSection>
  );
}
