import {
  ClipboardCopyIcon,
  CompassIcon,
  GaugeIcon,
  LogOutIcon,
  MoonIcon,
  RefreshCwIcon,
  SunIcon,
} from "lucide-react";

import { desktopWindow, hasDesktopWindowControls } from "~/api/desktopWindow";
import { fetchStatus } from "~/api/status";
import { navShortcutHint } from "~/components/ui/app-nav";
import { updateSettings } from "~/hooks/useSettings";
import { openTour } from "~/onboarding";
import { providerLabel } from "~/providers/registry";
import { VIEWS } from "~/views/registry";

import { dispatchPaletteAction } from "./actions";
import { registerCommands } from "./registry";
import { formatStatusLine } from "./statusLine";
import type { PaletteCommand } from "./types";

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

export type Translate = (message: string, values?: Record<string, unknown>) => string;

export interface BuiltinCommandOptions {
  readonly gt: Translate;
  /** Current theme value, used to label the toggle command. */
  readonly theme: "system" | "light" | "dark";
}

/**
 * The T3 command palette: destinations and the few global actions, nothing else. Deep links into
 * individual settings sections, metric/period pickers and one-off diagnostics are deliberately not
 * here - they duplicate navigation or are too obscure for a first-time user.
 */
export function createBuiltinCommands({ gt, theme }: BuiltinCommandOptions): PaletteCommand[] {
  const mac = isMacPlatform();
  const commands: PaletteCommand[] = [
    {
      id: "view.usage",
      title: gt("Usage"),
      group: gt("Views"),
      groupOrder: 10,
      description: gt("Cost, tokens and limits"),
      keywords: ["home", "dashboard", "limits"],
      icon: GaugeIcon,
      shortcut: navShortcutHint("usage", mac),
      run: () => {
        dispatchPaletteAction({ type: "switchView", viewId: "usage" });
      },
    },
  ];

  for (const view of VIEWS) {
    commands.push({
      id: `view.${view.id}`,
      title: gt(view.title),
      group: gt("Views"),
      groupOrder: 10,
      icon: view.icon,
      shortcut: navShortcutHint(view.id, mac),
      keywords: view.id === "settings" ? ["preferences", "options"] : [view.id],
      run: () => {
        dispatchPaletteAction({ type: "switchView", viewId: view.id });
      },
    });
  }

  commands.push(
    {
      id: "action.refreshLimits",
      title: gt("Refresh limits"),
      group: gt("Actions"),
      groupOrder: 20,
      description: gt("Probe providers again now"),
      keywords: ["reload", "update", "usage"],
      icon: RefreshCwIcon,
      run: () => {
        dispatchPaletteAction({ type: "refreshLimits" });
      },
    },
    {
      id: "action.copyStatus",
      title: gt("Copy status"),
      group: gt("Actions"),
      groupOrder: 20,
      description: gt("Copy a one-line summary of your limits"),
      keywords: ["clipboard", "summary", "limits", "share", "remaining"],
      icon: ClipboardCopyIcon,
      run: async () => {
        const status = await fetchStatus();
        const line = formatStatusLine(status, Date.now(), (account) =>
          account.label ?? (account.provider ? providerLabel(account.provider) : gt("Account")),
        );
        await navigator.clipboard.writeText(line);
        return gt("Copied: {line}", { line });
      },
    },
    {
      id: "action.toggleTheme",
      title: theme === "dark" ? gt("Switch to light mode") : gt("Switch to dark mode"),
      group: gt("Actions"),
      groupOrder: 20,
      description: gt("Change the app appearance"),
      keywords: ["theme", "appearance", "dark", "light"],
      icon: theme === "dark" ? SunIcon : MoonIcon,
      value: theme === "dark" ? gt("Dark") : theme === "light" ? gt("Light") : gt("System"),
      run: () => updateSettings({ theme: theme === "dark" ? "light" : "dark" }),
    },
    {
      id: "action.openTour",
      title: gt("Welcome tour"),
      group: gt("Actions"),
      groupOrder: 20,
      description: gt("Replay the first-run walkthrough"),
      keywords: ["onboarding", "setup", "welcome", "guide"],
      icon: CompassIcon,
      run: openTour,
    },
    {
      id: "action.quit",
      title: gt("Quit Burnrate"),
      group: gt("Actions"),
      groupOrder: 20,
      description: gt("Close or hide the window"),
      keywords: ["exit", "close", "quit"],
      icon: LogOutIcon,
      run: () => {
        if (hasDesktopWindowControls()) void desktopWindow.close().catch(() => undefined);
        else if (typeof window !== "undefined") window.close();
      },
    },
  );

  return commands;
}

/** Register the built-ins; returns a function that removes exactly these registrations. */
export function registerBuiltinCommands(options: BuiltinCommandOptions): () => void {
  return registerCommands(createBuiltinCommands(options));
}
