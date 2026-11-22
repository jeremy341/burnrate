/**
 * The Burnrate settings contract (v2). Source of truth is the server (`/api/settings`); the browser keeps a
 * write-through mirror only for first paint. See docs/CONTRACTS.md, "Settings".
 *
 * Rules: every field has a default below; unknown keys are preserved on import but never read; secrets
 * (webhook URLs, ntfy tokens, API keys) never live here, they go through the encrypted key store.
 */
import type { ThemeDefinition } from "~/shared/themePalettes";

export const SETTINGS_SCHEMA_VERSION = 2;

export type ThemeMode = "system" | "light" | "dark";
export type Density = "compact" | "comfortable" | "spacious";

export interface GeneralSettings {
  /** Start Burnrate when you sign in to the computer (off by default). */
  launchAtLogin: boolean;
  /** Start without opening the main window. */
  startMinimized: boolean;
  /** Closing the main window keeps Burnrate running in the tray. */
  closeToTray: boolean;
  /** "system" or a BCP 47 tag. */
  language: string;
  /** Ask GitHub for new versions (network call, off by default). */
  checkForUpdates: boolean;
  timestampFormat: "locale" | "12-hour" | "24-hour";
  /** Blur emails, account names and paths in the UI. */
  hideSensitive: boolean;
}

export interface AppearanceSettings {
  themeMode: ThemeMode;
  /** Ids of built-in or custom themes; null = the stock palette for that appearance. */
  lightThemeId: string | null;
  darkThemeId: string | null;
  /** User themes keyed by id (server persisted, 100 KB CSS cap per theme as in T3). */
  customThemes: Record<string, ThemeDefinition>;
  /** @deprecated ignored — the app uses T3's fixed radius token. Saved values still load. */
  radius?: number;
  /** @deprecated ignored — a single fixed density is used. */
  density?: Density;
  /** @deprecated ignored — a single fixed interface scale is used. */
  uiScale?: number;
  fontFamily: string | null;
  monoFontFamily: string | null;
  reduceMotion: "system" | "on" | "off";
  highContrast: boolean;
}

export interface UsageSettings {
  defaultView: "cost" | "tokens" | "limits";
  /** @deprecated ignored — there is no longer a control for it; any saved value is tolerated. */
  defaultPeriod: "today" | "7d" | "30d" | "90d";
  /** Seconds between automatic limit refreshes while a window is visible (min 30). */
  refreshIntervalSec: number;
  /** Days of limit history to keep (0 = off). */
  historyDays: number;
  refreshOnFocus: boolean;
  /** Keep refreshing while hidden/minimized (off: saves battery and RAM). */
  pollWhenHidden: boolean;
  showPaceTick: boolean;
  showTimeToEmpty: boolean;
  /** Show "remaining" (T3 default) or "used" on bars. */
  barMode: "remaining" | "used";
  currency: string;
  usagePriceOverrides: Record<string, unknown>;
  usageModelAliases: Record<string, string>;
}

export interface ProviderSettings {
  /** Provider ids hidden from every view. */
  hidden: string[];
  /** Display order; unknown ids sort after. */
  order: string[];
  /** Read the Claude Code login token to call Anthropic's usage endpoint (default on; off = transcripts/statusline only). */
  claudeOAuthProbe: boolean;
  /** Load user provider definitions from the data directory. */
  customDefinitions: boolean;
  /** Per-provider overrides, e.g. {"openrouter": {"pollSeconds": 300}}. */
  overrides: Record<string, { pollSeconds?: number; enabled?: boolean }>;
  /**
   * Extra local folders to read an agent's files from, in addition to what Burnrate finds on its own
   * (`~/.claude*`, `~/.vibe*`, `CLAUDE_CONFIG_DIR`, `VIBE_HOME`). Empty lists mean automatic discovery only.
   * `claude`: Claude Code config folders (each holds `projects/`). `vibe`: Mistral Vibe config folders
   * (each holds `logs/` and, for a second profile, `.env` or `keyring.bin`). Absolute paths or `~/...`.
   */
  sources: { claude: string[]; vibe: string[] };
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" local time. */
  start: string;
  end: string;
}

export interface NotificationChannelFlags {
  /** The secret itself is stored in the key store; this only says it is set. */
  enabled: boolean;
  configured: boolean;
}

export interface NotificationSettings {
  /** Master switch. Everything below is inert while false. OFF by default. */
  enabled: boolean;
  desktop: boolean;
  sound: boolean;
  /** Percent used at which to alert, ascending. */
  thresholds: number[];
  /** Alert when the burn rate predicts running out before the window resets. */
  predictRunout: boolean;
  notifyOnReset: boolean;
  notifyOnExpiredLogin: boolean;
  quietHours: QuietHours;
  /** ISO time until which alerts are snoozed, or null. */
  snoozeUntil: string | null;
  /** Minimum minutes between two alerts for the same window. */
  cooldownMinutes: number;
  perProvider: Record<string, { enabled?: boolean; thresholds?: number[] }>;
  channels: { ntfy: NotificationChannelFlags; discord: NotificationChannelFlags; webhook: NotificationChannelFlags };
}

export interface ShellSettings {
  tray: boolean;
  /** Global shortcut to toggle the main window, e.g. "Ctrl+Shift+B"; null = none. */
  globalShortcut: string | null;
}

export interface AdvancedSettings {
  /** Loopback JSON API for the CLI and integrations (read-only). */
  localApi: boolean;
  logLevel: "error" | "warn" | "info" | "debug";
  /** Ignore custom themes and CSS on next start (recovery). */
  safeMode: boolean;
  /** @deprecated ignored — optional experiment flags in saved files are tolerated, never validated. */
  experimental?: Record<string, boolean>;
}

export interface AppSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  /** Onboarding completed flag; replaces `advanced.experimental.onboarded`. Older files omit it. */
  onboarded?: boolean;
  general: GeneralSettings;
  appearance: AppearanceSettings;
  usage: UsageSettings;
  providers: ProviderSettings;
  notifications: NotificationSettings;
  shell: ShellSettings;
  advanced: AdvancedSettings;
}

/**
 * Arrays are replaced wholesale, maps accept `null` per key (delete) and their values are
 * partially patched too, matching the server's deep-merge rules in CONTRACTS section 2.
 */
type DeepPartialValue<T> = T extends unknown[]
  ? T
  : T extends object
    ? string extends keyof T
      ? T extends Record<string, infer V>
        ? { [K in string]?: DeepPartialValue<V> | null }
        : never
      : { [K in keyof T]?: DeepPartialValue<T[K]> | null }
    : T;
export type DeepPartial<T> = { [K in keyof T]?: DeepPartialValue<T[K]> };
export type SettingsPatch = DeepPartial<AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  onboarded: false,
  general: {
    launchAtLogin: false,
    startMinimized: false,
    closeToTray: true,
    language: "system",
    checkForUpdates: false,
    timestampFormat: "locale",
    hideSensitive: false,
  },
  appearance: {
    themeMode: "dark",
    lightThemeId: null,
    darkThemeId: "burnrate-dark",
    customThemes: {},
    // No radius default: the app uses T3's fixed radius token. Saved values still load (ignored).
    density: "comfortable",
    uiScale: 1,
    fontFamily: null,
    monoFontFamily: null,
    reduceMotion: "system",
    highContrast: false,
  },
  usage: {
    defaultView: "limits",
    defaultPeriod: "7d",
    refreshIntervalSec: 120,
    historyDays: 90,
    refreshOnFocus: true,
    pollWhenHidden: false,
    showPaceTick: true,
    showTimeToEmpty: true,
    barMode: "remaining",
    currency: "USD",
    usagePriceOverrides: {},
    usageModelAliases: {},
  },
  providers: {
    hidden: [],
    order: [],
    claudeOAuthProbe: true,
    customDefinitions: true,
    overrides: {},
    sources: { claude: [], vibe: [] },
  },
  notifications: {
    enabled: false,
    desktop: false,
    sound: false,
    thresholds: [80, 90, 100],
    predictRunout: false,
    notifyOnReset: false,
    notifyOnExpiredLogin: false,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    snoozeUntil: null,
    cooldownMinutes: 30,
    perProvider: {},
    channels: {
      ntfy: { enabled: false, configured: false },
      discord: { enabled: false, configured: false },
      webhook: { enabled: false, configured: false },
    },
  },
  shell: { tray: true, globalShortcut: null },
  advanced: { localApi: false, logLevel: "warn", safeMode: false, experimental: {} },
};
