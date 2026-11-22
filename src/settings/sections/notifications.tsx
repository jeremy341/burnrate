import { CircleAlertIcon, CircleCheckIcon, SendIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { getNotificationPermission, requestDesktopPermission } from "~/alerts";
import { sendTestAlert } from "~/api/alerts";
import type { AlertSecretName } from "~/api/secrets";
import { ChannelSecretField } from "~/components/settings/ChannelSecretField";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { msg, useGT } from "~/i18n";
import type { SettingsPatch } from "~/settings/schema";
import { flushSettings, updateSettings, useSettings } from "~/settings/store";

import { isDesktopShell } from "../environment";
import {
  SettingsBlock,
  SettingsNotice,
  SettingsNoticeStack,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "../layout";
import {
  desktopSwitchBlocked,
  desktopSwitchChecked,
  desktopToggleOutcome,
  testFeedback,
  type DesktopPermission,
  type TestFeedback,
} from "../notificationsLogic";
import { SECTION_GROUPS, type SectionDef } from "../types";

export { requestDesktopPermission };

const CHANNELS: ReadonlyArray<{
  readonly id: AlertSecretName;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { id: "ntfy", label: "ntfy", placeholder: "https://ntfy.sh/my-topic" },
  { id: "discord", label: "Discord", placeholder: "https://discord.com/api/webhooks/..." },
  { id: "webhook", label: "Webhook", placeholder: "https://example.com/hook" },
];

function currentPermission(): DesktopPermission {
  return typeof Notification === "undefined" ? "unsupported" : (getNotificationPermission() ?? "unsupported");
}

/** Compact editor for the whole-percent thresholds that fire an alert. */
function ThresholdChips({
  value,
  onChange,
  label,
}: {
  readonly value: number[];
  readonly onChange: (next: number[]) => void;
  readonly label: string;
}) {
  const gt = useGT();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const parsed = Number(draft);
  const invalid = draft !== "" && (!Number.isInteger(parsed) || parsed < 1 || parsed > 100);
  const duplicate = draft !== "" && value.includes(parsed);

  const add = () => {
    if (draft === "" || invalid || duplicate) return;
    onChange([...value, parsed].sort((a, b) => a - b));
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.length === 0 ? (
          <span className="text-xs text-muted-foreground">{gt("No thresholds")}</span>
        ) : null}
        {value.map((n) => (
          <span
            key={n}
            className="inline-flex h-7 items-center gap-0.5 rounded-full border bg-card ps-2.5 pe-0.5 text-xs font-medium tabular-nums"
          >
            {n}%
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className="rounded-full"
              aria-label={gt("Remove {n}% threshold", { n })}
              onClick={() => onChange(value.filter((v) => v !== n))}
            >
              <XIcon />
            </Button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          min={1}
          max={100}
          step={1}
          value={draft}
          aria-label={label}
          aria-invalid={invalid || duplicate}
          aria-describedby={invalid || duplicate ? errorId : undefined}
          className="w-20"
          placeholder={gt("1-100")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <Button size="sm" variant="outline" disabled={draft === "" || invalid || duplicate} onClick={add}>
          {gt("Add")}
        </Button>
        {invalid || duplicate ? (
          <span id={errorId} role="alert" className="text-xs text-destructive-foreground">
            {duplicate ? gt("Already added.") : gt("Enter a whole number from 1 to 100.")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Notifications() {
  const gt = useGT();
  const settings = useSettings((s) => s.notifications);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState<AlertSecretName | null>(null);
  const [testResult, setTestResult] = useState<{ channel: AlertSecretName; feedback: TestFeedback } | null>(null);
  const [permission, setPermission] = useState<DesktopPermission>(currentPermission);

  const muted = !settings.enabled;
  const inDesktopShell = isDesktopShell();

  // Every change is written immediately; there is no Save or Apply step.
  const patch = (value: SettingsPatch) => {
    setError("");
    setTestResult(null);
    void updateSettings(value);
  };

  // Persist `desktop: true` only once the toast can really appear: the desktop shell raises native
  // toasts itself, a browser tab needs the permission.
  const toggleDesktop = (checked: boolean) => {
    if (!checked) {
      patch({ notifications: { desktop: false } });
      return;
    }
    const answer: Promise<DesktopPermission> = inDesktopShell
      ? Promise.resolve(permission)
      : requestDesktopPermission().then((result): DesktopPermission => result ?? "unsupported");
    void answer.then((result) => {
      setPermission(result);
      const outcome = desktopToggleOutcome(true, inDesktopShell, result);
      if (outcome.persist) {
        patch({ notifications: { desktop: true } });
        return;
      }
      setError(
        outcome.message === "unsupported"
          ? gt("This browser cannot show desktop notifications. In-app alerts still work.")
          : gt("Allow notifications for this site, then turn this on again."),
      );
    });
  };

  // Per-channel test: only that channel is tried and the line beside the button reports the real
  // outcome (delivered, or the reason it was not), so "Send test" never claims more than happened.
  const doTest = async (channel: AlertSecretName, label: string) => {
    setTesting(channel);
    setTestResult(null);
    setError("");
    try {
      await flushSettings();
      const result = await sendTestAlert(channel);
      setTestResult({ channel, feedback: testFeedback(label, result) });
    } catch (cause) {
      setTestResult({ channel, feedback: testFeedback(label, { error: cause }) });
    } finally {
      setTesting(null);
    }
  };

  const feedbackText = (feedback: TestFeedback, label: string): string => {
    if (feedback.kind === "delivered") return gt("Delivered to {name}.", { name: label });
    if (feedback.kind === "needsSecret") return gt("Save a URL or token first, then send a test.");
    if (feedback.kind === "unreachable") return gt("Not delivered: could not reach that address. Check the URL and your connection.");
    return feedback.reason
      ? gt("Not delivered: {reason}", { reason: feedback.reason })
      : gt("Not delivered. Check the URL and your connection.");
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsNoticeStack>
        <SettingsNotice kind="error">{error}</SettingsNotice>
      </SettingsNoticeStack>

      <SettingsSection title={gt("Notifications")} description={gt("Alerts about your usage limits. Off by default.")}>
        <SettingsSwitchRow
          id="notifications-enabled"
          title={gt("Enable notifications")}
          description={gt("Turn on to choose what you are alerted about and where.")}
          checked={settings.enabled}
          onCheckedChange={(checked) => patch({ notifications: { enabled: checked } })}
        />
      </SettingsSection>

      <div inert={muted} data-settings-unavailable-target="notifications-enabled" className={muted ? "flex flex-col gap-6 opacity-64 transition-opacity" : "flex flex-col gap-6 transition-opacity"}>
        <SettingsSection title={gt("When")}>
          <SettingsBlock
            id="notifications-thresholds"
            title={gt("Warn when used reaches")}
            description={gt("One alert each time a window crosses one of these percentages.")}
          >
            <ThresholdChips
              value={settings.thresholds}
              onChange={(thresholds) => patch({ notifications: { thresholds } })}
              label={gt("New threshold percent")}
            />
          </SettingsBlock>
          <SettingsSwitchRow
            id="notifications-predict-runout"
            title={gt("Predict running out")}
            description={gt("Alert when your pace would empty a window before it resets.")}
            checked={settings.predictRunout}
            onCheckedChange={(checked) => patch({ notifications: { predictRunout: checked } })}
          />
          <SettingsSwitchRow
            id="notifications-notify-on-reset"
            title={gt("Notify when a limit resets")}
            description={gt("A quiet note when a busy window rolls over.")}
            checked={settings.notifyOnReset}
            onCheckedChange={(checked) => patch({ notifications: { notifyOnReset: checked } })}
          />
          <SettingsSwitchRow
            id="notifications-notify-on-expired-login"
            title={gt("Notify on expired login")}
            description={gt("When a provider keeps reporting an expired sign-in.")}
            checked={settings.notifyOnExpiredLogin}
            onCheckedChange={(checked) => patch({ notifications: { notifyOnExpiredLogin: checked } })}
          />
        </SettingsSection>

        <SettingsSection title={gt("Delivery")}>
          <SettingsSwitchRow
            id="notifications-desktop"
            title={gt("Desktop notifications")}
            description={
              inDesktopShell
                ? gt("Show a system toast as well as the in-app alert.")
                : desktopSwitchBlocked(false, permission)
                  ? gt("Blocked by the browser. Allow notifications for this site to use this option.")
                  : gt("Show a system toast as well as the in-app alert.")
            }
            checked={desktopSwitchChecked(settings.desktop, inDesktopShell, permission)}
            onCheckedChange={toggleDesktop}
            disabled={desktopSwitchBlocked(inDesktopShell, permission)}
          />
          <SettingsSwitchRow
            id="notifications-sound"
            title={gt("Sound")}
            description={gt("Play a short sound for critical alerts.")}
            checked={settings.sound}
            onCheckedChange={(checked) => patch({ notifications: { sound: checked } })}
          />
        </SettingsSection>

        <SettingsSection
          id="notifications-channels"
          title={gt("Channels")}
          description={gt("Secrets are stored encrypted and are never shown again.")}
        >
          {CHANNELS.map((channel) => {
            const enabled = settings.channels[channel.id]?.enabled ?? false;
            return (
              <SettingsRow
                key={channel.id}
                id={`notifications-channel-${channel.id}`}
                title={gt(channel.label)}
                inlineControl
                description={gt("Send alerts through {name}.", { name: gt(channel.label) })}
                control={(descriptionProps) => (
                  <Switch
                    {...descriptionProps}
                    checked={enabled}
                    aria-label={gt("Enable {name} alerts", { name: gt(channel.label) })}
                    onCheckedChange={(checked) =>
                      patch({ notifications: { channels: { [channel.id]: { enabled: checked } } } })
                    }
                  />
                )}
              >
                {enabled ? (
                  <div className="flex flex-col gap-3 pt-2.5">
                    <ChannelSecretField
                      name={channel.id}
                      label={gt("{name} URL or token", { name: gt(channel.label) })}
                      placeholder={gt(channel.placeholder)}
                      disabled={muted}
                      configured={settings.channels[channel.id]?.configured ?? false}
                      onConfiguredChange={(configured) =>
                        patch({ notifications: { channels: { [channel.id]: { configured } } } })
                      }
                    />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={testing !== null || !(settings.channels[channel.id]?.configured ?? false)}
                        aria-busy={testing === channel.id}
                        onClick={() => void doTest(channel.id, gt(channel.label))}
                      >
                        <SendIcon aria-hidden />
                        {testing === channel.id ? gt("Sending…") : gt("Send test")}
                      </Button>
                      {testResult?.channel === channel.id ? (
                        <span
                          role={testResult.feedback.kind === "delivered" ? "status" : "alert"}
                          className={
                            testResult.feedback.kind === "delivered"
                              ? "flex items-center gap-1 text-xs text-success-foreground"
                              : "flex items-center gap-1 text-xs text-destructive-foreground"
                          }
                        >
                          {testResult.feedback.kind === "delivered" ? (
                            <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
                          ) : (
                            <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                          )}
                          {feedbackText(testResult.feedback, gt(channel.label))}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </SettingsRow>
            );
          })}
        </SettingsSection>
      </div>
    </div>
  );
}

export const section: SectionDef = {
  id: "notifications",
  title: msg("Notifications"),
  order: 50,
  group: msg(SECTION_GROUPS.preferences),
  Component: Notifications,
};

/** Extra search terms for the flat settings index. */
export const keywords = [
  "alerts",
  "notify",
  "thresholds",
  "ntfy",
  "discord",
  "webhook",
  "sound",
  "desktop",
];
