import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./ui/button";
import { DIALOG_BACKDROP_CLASS } from "./ui/dialog-styles";

/**
 * The large rounded card T3 Code opens Usage and Settings in: backdrop, inset viewport, a popup capped
 * at 60rem by 80rem with a border and a deep shadow. Same classes as T3's route modal; Burnrate has no
 * page behind it, so the backdrop only dims the app background.
 */
export function AppModalFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className={`${DIALOG_BACKDROP_CLASS}`} aria-hidden />
      <div className="fixed inset-0 z-50 flex items-center justify-center sm:p-6 sm:pt-[1.5rem] lg:p-10">
        <div
          role="dialog"
          aria-label={label}
          data-slot="dialog-popup"
          data-app-modal=""
          className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
        >
          {children}
        </div>
      </div>
    </>
  );
}

export function AppModalClose({ onClose }: { onClose: () => void }) {
  return (
    <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
      <XIcon />
    </Button>
  );
}
