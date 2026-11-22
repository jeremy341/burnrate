/**
 * Shortcuts settings, laid out like T3's keybindings page: one row per action with the current
 * shortcut shown as <Kbd> chips, click to rebind and a visible reset. Recording saves immediately —
 * there is no Save/Apply button and no "not applied yet" note.
 */
import { TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { msg, useGT } from "~/i18n";
import { SettingsRow, SettingsSection } from "~/settings/layout";
import { DEFAULT_SETTINGS } from "~/settings/schema";
import {
  comboFromKeyboardEvent,
  comboLabel,
  conflictingInAppShortcuts,
  IN_APP_SHORTCUTS,
  isSuitableGlobalShortcut,
  normalizeGlobalShortcut,
  shortcutKeyParts,
} from "~/settings/shortcuts";
import { updateSettings, useSettings } from "~/settings/store";
import { SECTION_GROUPS, type SectionDef } from "~/settings/types";

/** T3's key caps: an optional chord prefix ("g then u") followed by the combo's parts. */
function ShortcutKeys({ combo, prefix }: { combo: string; prefix?: string }) {
  const gt = useGT();
  return (
    <>
      <span className="sr-only">
        {prefix
          ? gt("{first} then {second}", { first: comboLabel(prefix), second: comboLabel(combo) })
          : comboLabel(combo)}
      </span>
      <KbdGroup aria-hidden className="flex-wrap justify-end">
        {prefix ? (
          <>
            <Kbd className="text-foreground">{comboLabel(prefix)}</Kbd>
            <span className="text-2xs text-muted-foreground">{gt("then")}</span>
          </>
        ) : null}
        {shortcutKeyParts(combo).map((part, index) => (
          <Kbd className="text-foreground" key={`${part}-${index}`}>
            {part}
          </Kbd>
        ))}
      </KbdGroup>
    </>
  );
}

function Shortcuts() {
  const gt = useGT();
  const storedShortcut = useSettings((settings) => settings.shell.globalShortcut);
  // An empty string means "no shortcut", never a binding.
  const combo = normalizeGlobalShortcut(storedShortcut);
  const [recording, setRecording] = useState(false);
  const captureRef = useRef<HTMLButtonElement>(null);

  const changed = combo !== normalizeGlobalShortcut(DEFAULT_SETTINGS.shell.globalShortcut);
  const conflicts = combo ? conflictingInAppShortcuts(combo) : [];
  const conflictText =
    conflicts.length === 1
      ? gt("Also used by {command}.", { command: gt(conflicts[0]!.label) })
      : conflicts.length > 1
        ? gt("Also used by {count} other shortcuts.", { count: conflicts.length })
        : null;

  useEffect(() => {
    if (recording) captureRef.current?.focus();
  }, [recording]);

  // Recording applies instantly: the optimistic store update re-renders the chips on the next key.
  const saveShortcut = (next: string) => {
    setRecording(false);
    void updateSettings({ shell: { globalShortcut: next } });
  };

  const captureKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // Tab keeps keyboard navigation working; Escape cancels without closing the settings page.
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    if (event.repeat) return;
    const next = comboFromKeyboardEvent(event);
    if (next === null || !isSuitableGlobalShortcut(next)) return; // keep waiting for a real combo
    saveShortcut(next);
  };

  // The default is "no shortcut", so resetting and removing are the same write.
  const removeShortcut = () => {
    void updateSettings({ shell: { globalShortcut: DEFAULT_SETTINGS.shell.globalShortcut } });
  };

  const groups = [
    {
      id: "navigation",
      title: gt("Navigation"),
      shortcuts: IN_APP_SHORTCUTS.filter((shortcut) => !shortcut.command.startsWith("usage.")),
    },
    {
      id: "usage",
      title: gt("Usage"),
      shortcuts: IN_APP_SHORTCUTS.filter((shortcut) => shortcut.command.startsWith("usage.")),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection desktopOnly title={gt("Global shortcut")}>
        <SettingsRow
          id="shortcuts-global"
          title={gt("Toggle main window")}
          description={
            <>
              <span>
                {recording
                  ? gt("Press the new keys, or Esc to cancel.")
                  : gt("Show or hide Burnrate from anywhere.")}
              </span>
              {conflictText ? (
                <span className="mt-1 flex items-center gap-1.5 text-warning-foreground">
                  <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
                  {conflictText}
                </span>
              ) : null}
            </>
          }
          control={(descriptionProps) => (
            <div className="flex min-w-0 items-center gap-1.5">
              <Button
                {...descriptionProps}
                ref={captureRef}
                type="button"
                variant={recording ? "secondary" : "outline"}
                size="sm"
                data-keybinding-capture={recording ? "" : undefined}
                aria-label={
                  recording
                    ? gt("Recording a shortcut. Press a key combination or Escape to cancel.")
                    : combo
                      ? gt("Change shortcut, currently {shortcut}", { shortcut: comboLabel(combo) })
                      : gt("Record a shortcut")
                }
                className="gap-1.5"
                onClick={() => setRecording(true)}
                onKeyDown={captureKey}
                onBlur={() => {
                  if (recording) setRecording(false);
                }}
              >
                {recording ? gt("Press keys…") : combo ? <ShortcutKeys combo={combo} /> : gt("Record shortcut")}
              </Button>
              {changed ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={recording}
                        aria-label={gt("Remove shortcut")}
                        onClick={removeShortcut}
                      />
                    }
                  >
                    <XIcon aria-hidden className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{gt("Remove shortcut")}</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          )}
        />
      </SettingsSection>

      {groups.map((group) => (
        <SettingsSection key={group.id} title={group.title}>
          {group.shortcuts.map((shortcut) => (
            <SettingsRow
              key={shortcut.command}
              title={gt(shortcut.label)}
              inlineControl
              control={<ShortcutKeys combo={shortcut.combo} prefix={shortcut.prefix} />}
            />
          ))}
        </SettingsSection>
      ))}
    </div>
  );
}

export const section: SectionDef = {
  id: "shortcuts",
  title: msg("Shortcuts"),
  order: 60,
  group: msg(SECTION_GROUPS.desktop),
  Component: Shortcuts,
};

/** Extra search terms for the flat settings index. */
export const keywords = ["keyboard", "hotkey", "global shortcut", "keybindings", "keys", "bindings"];
