import { msg } from "~/i18n";
import type { RegisteredSettingsRow } from "./search";

/**
 * Every settings row that has a DOM id, so global search finds it before its section has mounted.
 * Titles must match the visible row titles (a mounted row re-registers itself with the same id).
 * `settings/search.test.ts` fails when an id here has no section, so keep this list in step with the
 * `id="…"` props in `sections/*` and `components/settings/*`.
 */
const targets: Readonly<Record<string, readonly [section: string, title: string, keywords?: readonly string[]]>> = {
  "advanced-copy-diagnostics": ["advanced", msg("Copy diagnostics"), ["report", "bug", "support"]],
  "advanced-logs-folder": ["advanced", msg("Data folder"), ["logs", "data", "folder"]],
  "advanced-setup-tour": ["advanced", msg("Welcome tour"), ["setup", "onboarding", "guide"]],
  "appearance-color-scheme": ["appearance", msg("Appearance mode"), ["dark", "light", "system", "theme"]],
  "appearance-theme-library": ["appearance", msg("Theme library"), ["themes", "colors", "palette"]],
  "interface-font": ["appearance", msg("Interface font"), ["typography", "text"]],
  "mono-font": ["appearance", msg("Monospace font"), ["typography", "code"]],
  "typography": ["appearance", msg("Typography"), ["fonts", "text"]],
  "data-clear-history": ["data", msg("Clear usage history"), ["delete", "samples"]],
  "data-export": ["data", msg("Export settings"), ["backup", "download"]],
  "data-import": ["data", msg("Import settings"), ["restore", "upload"]],
  "data-reset-all": ["data", msg("Reset all settings"), ["defaults", "restore"]],
  "general-close-to-tray": ["general", msg("Close to tray"), ["tray", "background"]],
  "general-language": ["general", msg("Language"), ["locale", "translation"]],
  "general-launch-at-login": ["general", msg("Launch at login"), ["startup", "autostart"]],
  "general-start-minimized": ["general", msg("Start minimized"), ["startup", "hidden"]],
  "general-timestamp-format": ["general", msg("Time format"), ["clock", "24 hour", "12 hour"]],
  "notifications-channels": ["notifications", msg("Channels"), ["ntfy", "discord", "webhook"]],
  "notifications-desktop": ["notifications", msg("Desktop notifications"), ["toast", "system"]],
  "notifications-enabled": ["notifications", msg("Enable notifications"), ["alerts"]],
  "notifications-notify-on-expired-login": ["notifications", msg("Notify on expired login"), ["sign in"]],
  "notifications-notify-on-reset": ["notifications", msg("Notify when a limit resets"), ["reset"]],
  "notifications-predict-runout": ["notifications", msg("Predict running out"), ["forecast", "pace"]],
  "notifications-sound": ["notifications", msg("Sound"), ["audio", "beep"]],
  "notifications-thresholds": ["notifications", msg("Warn when used reaches"), ["percent", "warning"]],
  "providers-claude-login-probe": ["providers", msg("Read the local Claude login for limits"), ["claude", "credentials"]],
  "providers-custom-definitions": ["providers", msg("Load user provider definitions"), ["custom", "toml"]],
  "providers-polling": ["providers", msg("Polling overrides"), ["interval", "refresh"]],
  "providers-sources": ["providers", msg("Local sources"), ["folders", "paths"]],
  "providers-sources-claude": ["providers", msg("Claude Code folders"), ["profile", "config dir"]],
  "providers-sources-vibe": ["providers", msg("Mistral Vibe folders"), ["profile"]],
  "shortcuts-global": ["shortcuts", msg("Toggle main window"), ["hotkey", "global"]],
  "usage-budgets": ["usage", msg("Budgets"), ["spend", "cap", "monthly"]],
  "usage-custom-prices": ["usage", msg("Model prices"), ["cost", "pricing"]],
  "usage-default-period": ["usage", msg("Default period"), ["range", "days"]],
  "usage-default-view": ["usage", msg("Default metric"), ["cost", "tokens", "limits"]],
  "usage-hide-empty": ["usage", msg("Hide empty providers"), ["unused"]],
  "usage-refresh-interval": ["usage", msg("Refresh interval"), ["poll", "seconds"]],
};

export const SETTINGS_SEARCH_ROWS: readonly RegisteredSettingsRow[] = Object.entries(targets).map(
  ([id, [sectionId, title, keywords]]) => ({ id, sectionId, title, keywords }),
);
