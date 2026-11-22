/**
 * Port of T3 Code's `apps/web/src/components/settings/ThemeEditorHost.tsx` (MIT, T3 Tools Inc.).
 *
 * Mount once (App root or the appearance settings section). It renders the lazily loaded
 * `ThemeEditorPanel` for the current session, resolves the edited/seed theme from the custom
 * theme library, and makes a saved theme active. Errors are surfaced inside the panel, so this
 * host needs no toast dependency.
 */
import { lazy, Suspense, useSyncExternalStore } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "~/themePalette";

import { closeThemeEditor, useThemeEditorStore } from "./themeEditorStore";

const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);

function useThemeDefinition(id: string | null | undefined): ThemeDefinition | null {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

export function ThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const { theme, setTheme, themeHalves, refreshTheme } = useTheme();
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);

  const handleSaved = (
    savedTheme: ThemeDefinition,
    { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
  ): boolean => {
    if (mergedAppearance) {
      if (!setTheme(savedTheme.id)) return false;
      return true;
    }
    if (!created) {
      // Reapply the palette without setTheme, which would clear a mix containing the edited theme.
      const wasActive =
        getThemeDefinition(theme)?.id === savedTheme.id ||
        themeHalves?.light === savedTheme.id ||
        themeHalves?.dark === savedTheme.id;
      if (wasActive) refreshTheme();
      return true;
    }

    return setTheme(savedTheme.id);
  };

  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={editingTheme}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onOpenChange={(open) => {
          if (!open) closeThemeEditor();
        }}
        onSaved={handleSaved}
        open
        restoreTheme={refreshTheme}
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
