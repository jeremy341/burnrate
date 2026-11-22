/**
 * Appearance settings section (package 28, order 20).
 *
 * Matches T3's Appearance tab: the Appearance mode toggle, the theme library,
 * then typography. The theme editor host is mounted once here so the editor panel
 * survives while the user is on this section; it renders nothing until a session opens.
 */
import { AppearanceSettingsPanel } from "~/components/settings/AppearanceSettingsPanel";
import { ThemeEditorHost } from "~/components/settings/ThemeEditorHost";
import { ThemeSettings } from "~/components/settings/ThemeSettings";
import { TypographySettings } from "~/components/settings/TypographySettings";
import { msg } from "~/i18n";

import { SECTION_GROUPS, type SectionDef } from "../types";

function AppearanceSettings() {
  return (
    <div className="flex flex-col gap-6">
      <AppearanceSettingsPanel />
      <ThemeSettings />
      <TypographySettings />
      <ThemeEditorHost />
    </div>
  );
}

export const section: SectionDef = {
  id: "appearance",
  title: msg("Appearance"),
  order: 20,
  group: msg(SECTION_GROUPS.preferences),
  Component: AppearanceSettings,
};

/** Extra search terms for the flat settings index (package 25). */
export const keywords = [
  "appearance",
  "theme",
  "themes",
  "color",
  "colour",
  "scheme",
  "dark",
  "light",
  "system",
  "font",
  "fonts",
  "typography",
  "monospace",
  "text size",
];
