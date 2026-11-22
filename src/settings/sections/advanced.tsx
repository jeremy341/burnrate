import { useState } from "react";

import { DiagnosticsPanel } from "~/components/settings/DiagnosticsPanel";
import { Button } from "~/components/ui/button";
import { msg, useGT } from "~/i18n";
import { openTour } from "~/onboarding";
import { SettingsNotice, SettingsNoticeStack, SettingsRow, SettingsSection } from "~/settings/layout";
import { errorMessage, openDataFolder } from "~/settings/transfer";
import { SECTION_GROUPS, type SectionDef } from "~/settings/types";

function AdvancedSettingsSection() {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);

  const openLogsFolder = () => {
    setError(null);
    void openDataFolder().catch((cause: unknown) => setError(errorMessage(cause)));
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsNoticeStack>
        <SettingsNotice kind="error">{error}</SettingsNotice>
      </SettingsNoticeStack>

      <DiagnosticsPanel onOpenFolder={openLogsFolder} />

      <SettingsSection title={gt("Help")}>
        <SettingsRow
          id="advanced-setup-tour"
          title={gt("Welcome tour")}
          description={gt("Replay the quick tour for connecting your agents.")}
          keywords={["setup", "onboarding", "welcome", "tour", "guide"]}
          control={(descriptionProps) => (
            <Button {...descriptionProps} size="sm" variant="outline" onClick={openTour}>
              {gt("Start tour")}
            </Button>
          )}
        />
      </SettingsSection>
    </div>
  );
}

export const section: SectionDef = {
  id: "advanced",
  title: msg("Advanced"),
  order: 80,
  group: msg(SECTION_GROUPS.system),
  Component: AdvancedSettingsSection,
};

/** Extra search terms for the flat settings index. */
export const keywords = ["diagnostics", "logs", "setup", "tour", "report", "bug"];
