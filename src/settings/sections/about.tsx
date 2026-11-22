import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import licenseText from "../../../LICENSE?raw";
import noticeText from "../../../NOTICE?raw";
import pkg from "../../../package.json";

import { checkForUpdates, type UpdateCheckResult } from "~/api/diagnostics";
import { Button, InlineButton } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { msg, useGT } from "~/i18n";
import { updateSettings, useSettings } from "~/settings/store";
import { SettingsRow, SettingsSection } from "../layout";
import { SECTION_GROUPS, type SectionDef } from "../types";

const APP_VERSION: string = pkg.version;
const T3_CODE_URL = "https://github.com/pingdotgg/t3code";

/** Extra keywords are read by the settings search index (settings-shell package). */
export const keywords = ["version", "build", "licenses", "updates", "about", "t3 code"];

type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "result"; readonly outcome: UpdateOutcome };

export type UpdateOutcome =
  | { readonly kind: "current" }
  | { readonly kind: "available"; readonly latest: string; readonly url: string | null }
  | { readonly kind: "unreachable" };

/**
 * What a check answered. The server replies 200 with no `latest` when it could not read the release
 * (offline, GitHub down, rate limited); that is "could not check", never "up to date".
 */
export function updateOutcome(result: Partial<UpdateCheckResult> | null | undefined): UpdateOutcome {
  const latest = typeof result?.latest === "string" ? result.latest.trim() : "";
  if (latest.length === 0) return { kind: "unreachable" };
  if (result?.newer === true) {
    return { kind: "available", latest, url: typeof result.url === "string" && result.url ? result.url : null };
  }
  return { kind: "current" };
}

/** T3's AboutVersionTitle: "Version" with a copyable version chip. */
function VersionTitle({ version, copied, onCopy }: { version: string; copied: boolean; onCopy: () => void }) {
  const gt = useGT();
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{gt("Version")}</span>
      <code className="text-2xs font-medium">
        <Tooltip>
          <TooltipTrigger
            render={
              <InlineButton
                tone="muted"
                className="inline-flex min-h-6 items-center rounded-sm px-1.5 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={gt("Copy version {version}", { version })}
                onClick={onCopy}
              >
                {version}
              </InlineButton>
            }
          />
          <TooltipPopup>{copied ? gt("Copied") : gt("Copy version")}</TooltipPopup>
        </Tooltip>
      </code>
    </span>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <details data-slot="settings-row" className="group px-4 py-3">
      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 rounded-sm text-sm text-foreground outline-none marker:hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        {title}
      </summary>
      {/* A scrollable region needs to be reachable by keyboard (WCAG 2.1.1), so it is focusable and named. */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={title}
        className="mt-3 max-h-64 overflow-y-auto scroll-py-2 wrap-anywhere whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-2xs leading-relaxed text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {text}
      </pre>
    </details>
  );
}

function About() {
  const gt = useGT();
  const [versionCopied, setVersionCopied] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const checksAllowed = useSettings((settings) => settings.general.checkForUpdates);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const copyVersion = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(msg("Clipboard API is unavailable."));
      await navigator.clipboard.writeText(APP_VERSION);
      if (mounted.current) {
        setVersionCopied(true);
        window.setTimeout(() => {
          if (mounted.current) setVersionCopied(false);
        }, 2000);
      }
    } catch {
      // The version stays visible in the row; copying is a convenience only.
    }
  }, []);

  const check = useCallback(async () => {
    setUpdate({ kind: "loading" });
    try {
      // Pressing the button is the opt-in: the server only contacts GitHub once this is on, and
      // otherwise answers with nothing, which used to read as "Up to date".
      if (!checksAllowed) await updateSettings({ general: { checkForUpdates: true } });
      const result = await checkForUpdates();
      if (mounted.current) setUpdate({ kind: "result", outcome: updateOutcome(result) });
    } catch (cause) {
      if (!mounted.current) return;
      setUpdate({
        kind: "error",
        message: cause instanceof Error ? cause.message : msg("Update check failed."),
      });
    }
  }, [checksAllowed]);

  const updateDescription = (
    <div className="flex flex-col gap-1" aria-live="polite">
      <span>{gt("Looks for a newer release on GitHub when you press the button.")}</span>
      {update.kind === "result" && update.outcome.kind === "current" ? (
        <span>{gt("You're on the latest version.")}</span>
      ) : null}
      {update.kind === "result" && update.outcome.kind === "unreachable" ? (
        <span role="alert" className="text-destructive-foreground">
          {gt("Couldn't reach GitHub. Check your connection and try again.")}
        </span>
      ) : null}
      {update.kind === "result" && update.outcome.kind === "available" ? (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>{gt("Version {latest} is available.", { latest: update.outcome.latest })}</span>
          {update.outcome.url ? (
            <a
              href={update.outcome.url}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-sm text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {gt("View release")}
            </a>
          ) : null}
        </span>
      ) : null}
      {update.kind === "error" ? (
        <span role="alert" className="text-destructive-foreground">{update.message}</span>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title={gt("App")}>
        <SettingsRow
          title={<VersionTitle version={APP_VERSION} copied={versionCopied} onCopy={() => void copyVersion()} />}
          description={gt("Current version of the application.")}
        />
        <SettingsRow
          title={gt("Updates")}
          description={updateDescription}
          control={
            <Button size="sm" variant="outline" onClick={() => void check()} disabled={update.kind === "loading"}>
              <RefreshIcon refreshing={update.kind === "loading"} />
              {update.kind === "loading" ? gt("Checking…") : gt("Check for updates")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        title={gt("Legal")}
        description={gt("Burnrate is independent and is not affiliated with or endorsed by T3 Tools Inc.")}
      >
        <Notice title={gt("Burnrate license (MIT)")} text={licenseText} />
        <Notice title={gt("T3 Code attribution (NOTICE)")} text={noticeText} />
        <SettingsRow
          title={gt("T3 Code")}
          description={gt("The UI and design are derived from T3 Code.")}
          control={
            <Button
              size="sm"
              variant="outline"
              render={<a href={T3_CODE_URL} target="_blank" rel="noreferrer noopener" />}
            >
              {gt("View source")}
              <ExternalLinkIcon aria-hidden />
            </Button>
          }
        />
      </SettingsSection>

      <span className="sr-only" role="status" aria-live="polite">
        {versionCopied ? gt("Version copied to clipboard.") : ""}
      </span>
    </div>
  );
}

export const section: SectionDef = {
  id: "about",
  title: msg("About"),
  order: 100,
  group: msg(SECTION_GROUPS.system),
  Component: About,
};
