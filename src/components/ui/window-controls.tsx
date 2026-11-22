import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { desktopWindow } from "~/api/desktopWindow";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";

import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

function WindowButton({
  label,
  onClick,
  close = false,
  children,
}: {
  label: string;
  onClick: () => void;
  close?: boolean;
  children: ReactNode;
}) {
  // icon-sm is the shared header size (32px touch / 28px pointer). The old `sm:size-8`
  // override made these taller than the neighbouring Settings and back buttons on desktop.
  // The touch-target pseudo-element is suppressed only here: native titlebar controls stay
  // compact, and three 44px targets would not fit the drag strip.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={onClick}
            size="icon-sm"
            variant={close ? "ghost-destructive" : "ghost"}
            className="touch-manipulation pointer-coarse:after:content-none forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:-outline-offset-2"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function WindowControls({ active }: { active: boolean }) {
  const gt = useGT();
  const [maximized, setMaximized] = useState(false);
  const queryVersion = useRef(0);
  const toggling = useRef(false);

  // Only the visible screen listens. The app keeps past screens mounted to preserve their state.
  useEffect(() => {
    if (!active) return;
    function syncMaximized() {
      const version = ++queryVersion.current;
      void desktopWindow.isMaximized().then((value) => {
        if (version === queryVersion.current) setMaximized(value);
      }).catch(() => {
        // A resize can finish as the window closes. Only report failures for explicit actions.
      });
    }
    syncMaximized();
    window.addEventListener("resize", syncMaximized);
    return () => {
      queryVersion.current++;
      window.removeEventListener("resize", syncMaximized);
    };
  }, [active]);

  async function toggleMaximize() {
    if (toggling.current) return;
    toggling.current = true;
    try {
      const value = await desktopWindow.toggleMaximize();
      queryVersion.current++;
      setMaximized(value);
    } catch {
      toast.error(gt("Couldn't change the window size."));
    } finally {
      toggling.current = false;
    }
  }

  return (
    <div
      role="group"
      aria-label={gt("Window controls")}
      data-slot="window-controls"
      className="flex shrink-0 items-center gap-0.5 border-s ps-1"
    >
      <WindowButton
        label={gt("Minimize window")}
        onClick={() => void desktopWindow.minimize().catch(() => toast.error(gt("Couldn't minimize the window.")))}
      >
        <MinusIcon aria-hidden className="size-3.5" />
      </WindowButton>
      <WindowButton
        label={maximized ? gt("Restore window") : gt("Maximize window")}
        onClick={toggleMaximize}
      >
        {maximized ? <CopyIcon aria-hidden className="size-3.5" /> : <SquareIcon aria-hidden className="size-3.5" />}
      </WindowButton>
      <WindowButton
        close
        label={gt("Close window")}
        onClick={() => void desktopWindow.close().catch(() => toast.error(gt("Couldn't close the window.")))}
      >
        <XIcon aria-hidden className="size-3.5" />
      </WindowButton>
    </div>
  );
}
