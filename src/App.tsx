import { MoonIcon, PlugIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useLimits, useProviders } from "~/api";
import { Button } from "~/components/ui/button";
import { UsagePage } from "~/components/usage/UsagePage";
import { usePrimarySettings, updateSettings } from "~/hooks/useSettings";
import { ProvidersPage } from "~/ProvidersPage";

type View = "usage" | "providers";

/** The app window's title bar takes its color from the theme-color meta tag. */
function syncTitleBarColor() {
  requestAnimationFrame(() => {
    const probe = document.createElement("canvas").getContext("2d");
    const background = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
    if (!probe || !background) return;
    probe.fillStyle = "#000";
    probe.fillStyle = background;
    const color = probe.fillStyle;
    document.documentElement.style.background = color;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  });
}

function useTheme() {
  const theme = usePrimarySettings((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      syncTitleBarColor();
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return theme;
}

export function App() {
  const theme = useTheme();
  const [view, setView] = useState<View>("usage");
  const limits = useLimits();
  const providers = useProviders();
  const [limitsNow, setLimitsNow] = useState(() => Date.now());

  const refreshLimits = () => {
    setLimitsNow(Date.now());
    limits.reload();
    providers.reload();
  };

  const trailing = (
    <>
      <Button
        onClick={() => setView(view === "providers" ? "usage" : "providers")}
        aria-label="Providers"
        aria-pressed={view === "providers"}
        size="icon-sm"
        variant="ghost"
      >
        <PlugIcon className="size-4" />
      </Button>
      <Button
        onClick={() => updateSettings({ theme: theme === "dark" ? "light" : "dark" })}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        size="icon-sm"
        variant="ghost"
      >
        {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
      </Button>
    </>
  );

  if (view === "providers") {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-5 py-6">
        <header className="flex items-center gap-3">
          <h1 className="text-sm font-medium">Burnrate / Providers</h1>
          <div className="ms-auto flex items-center gap-1">
            <Button onClick={() => setView("usage")} size="sm" variant="outline">
              Back to usage
            </Button>
            <Button
              onClick={() => updateSettings({ theme: theme === "dark" ? "light" : "dark" })}
              aria-label="Toggle theme"
              size="icon-sm"
              variant="ghost"
            >
              {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
            </Button>
          </div>
        </header>
        <ProvidersPage providers={providers} />
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <UsagePage
        limits={limits.data}
        limitsNow={limitsNow}
        limitsLoading={limits.loading}
        onRefreshLimits={refreshLimits}
        trailing={trailing}
      />
    </div>
  );
}
