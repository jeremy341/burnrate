import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useLimits, useProviders } from "~/api";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { UsageLimitsSection } from "~/components/usage/UsageLimits";
import { usePrimarySettings, updateSettings } from "~/hooks/useSettings";
import { ProvidersPage } from "~/ProvidersPage";

type Tab = "limits" | "providers";
const NO_HIDDEN: ReadonlySet<string> = new Set();

function useTheme() {
  const theme = usePrimarySettings((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return theme;
}

export function App() {
  const theme = useTheme();
  const [tab, setTab] = useState<Tab>("limits");
  const limits = useLimits();
  const providers = useProviders();
  const [now, setNow] = useState(() => Date.now());

  const refresh = () => {
    setNow(Date.now());
    limits.reload();
    providers.reload();
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Burnrate</h1>
        <div className="ms-auto flex items-center gap-2">
          <ToggleGroup
            aria-label="View"
            variant="segmented"
            value={[tab]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "limits" || value === "providers") setTab(value);
            }}
          >
            <Toggle value="limits">Limits</Toggle>
            <Toggle value="providers">Providers</Toggle>
          </ToggleGroup>
          <Button
            onClick={refresh}
            aria-label="Refresh"
            aria-busy={limits.loading}
            disabled={limits.loading}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshIcon size="sm" refreshing={limits.loading} />
          </Button>
          <Button
            onClick={() => updateSettings({ theme: theme === "dark" ? "light" : "dark" })}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            size="icon-sm"
            variant="ghost"
          >
            {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </Button>
        </div>
      </header>
      <main>
        {tab === "limits" ? (
          limits.error ? (
            <p className="text-sm text-muted-foreground">Could not reach the Burnrate server.</p>
          ) : (
            <UsageLimitsSection
              accounts={limits.data?.accounts ?? []}
              notices={limits.data?.notices ?? []}
              hiddenProviders={NO_HIDDEN}
              now={now}
            />
          )
        ) : (
          <ProvidersPage providers={providers} />
        )}
      </main>
    </div>
  );
}
