/**
 * Appearance settings — the theme-mode toggle, ported 1:1 from T3 Code's
 * `AppearanceSettingsPanel.tsx` / `ThemeSettings.tsx` (MIT, T3 Tools Inc.).
 *
 * T3's Appearance tab shows exactly three things: the "Appearance mode" tiles,
 * the theme library, and typography. Burnrate keeps those three and nothing
 * else — the corner radius, density, UI scale, reduce motion and high contrast
 * rows were removed because the app uses T3's fixed radius and spacing tokens.
 *
 * The mode is written straight to the settings store, so it applies instantly.
 */
import { useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { SettingsSection } from "~/settings/layout";
import { updateSettings, useSettings } from "~/settings/store";
import { getThemeDefinition, type ThemeAppearance } from "~/themePalette";

import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
  type ThemeCardPreviewColors,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const MODE_OPTIONS = [
  { value: "system", label: "System", ariaLabel: "Follow the system appearance" },
  { value: "light", label: "Light", ariaLabel: "Use light mode" },
  { value: "dark", label: "Dark", ariaLabel: "Use dark mode" },
] as const;

export type ModePane = {
  readonly colors: ThemeCardPreviewColors;
  readonly clip?: "left" | "right";
};

/** T3 paints the System tile as two half-and-half panes, the others as one. */
export function modePanes(
  mode: ThemeMode,
  lightColors: ThemeCardPreviewColors,
  darkColors: ThemeCardPreviewColors,
): readonly ModePane[] {
  if (mode === "system") {
    return [
      { clip: "left", colors: lightColors },
      { clip: "right", colors: darkColors },
    ];
  }
  return [{ colors: mode === "dark" ? darkColors : lightColors }];
}

function cardColors(themeId: string | null, mode: ThemeAppearance): ThemeCardPreviewColors {
  const definition = themeId ? getThemeDefinition(themeId) : null;
  const card = definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0]!;
  return previewColorsOf(card, mode) ?? card.previews[0]!.colors;
}

export function AppearanceSettingsPanel() {
  const gt = useGT();
  const appearance = useSettings((settings) => settings.appearance);

  const lightColors = cardColors(appearance.lightThemeId, "light");
  const darkColors = cardColors(appearance.darkThemeId, "dark");

  const setThemeMode = (mode: ThemeMode): void => {
    void updateSettings({ appearance: { themeMode: mode } }).catch(() => {
      // The store rolled the value back and showed an error toast already.
    });
  };

  return (
    <SettingsSection
      hideTitle
      id="appearance-color-scheme"
      title={gt("Appearance mode")}
      variant="plain"
    >
      <div
        aria-label={gt("Appearance mode")}
        className="grid w-full grid-cols-3 gap-3"
        id="setting-theme-mode"
        role="group"
      >
        {MODE_OPTIONS.map((mode) => {
          const active = appearance.themeMode === mode.value;
          return (
            <button
              aria-label={gt(mode.ariaLabel)}
              aria-pressed={active}
              className={cn(
                "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-7 focus-visible:outline-foreground/60",
                active
                  ? "border-transparent bg-accent/30 ring-2 ring-inset ring-ring forced-colors:outline-2 forced-colors:outline-solid forced-colors:-outline-offset-2 forced-colors:outline-[Highlight]"
                  : "border-border bg-card hover:bg-accent/10",
              )}
              key={mode.value}
              onClick={() => setThemeMode(mode.value)}
              type="button"
            >
              <ThemeWireframe
                className="h-[8.75rem]"
                panes={modePanes(mode.value, lightColors, darkColors)}
              />
              <span
                className={cn(
                  "flex items-center justify-center text-xs font-medium",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {gt(mode.label)}
              </span>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}
