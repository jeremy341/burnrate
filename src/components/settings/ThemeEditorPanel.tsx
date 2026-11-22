/**
 * Port of T3 Code's `apps/web/src/components/settings/ThemeEditorPanel.tsx`
 * (MIT, T3 Tools Inc.) — the floating theme editor, kept 1:1 with T3's layout,
 * sections, field rows, colour pickers and save/merge semantics.
 *
 * Effect/atom/T3-runtime imports are replaced with `~/themePalette`, `~/i18n`, `~/lib/*` and the
 * local session store. As in T3, edits preview live through `applyThemeColorPreview` and are
 * persisted on Save; every close path (Cancel, Esc, X, unmount) restores the active theme.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MousePointer2Icon,
  PaintbrushIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { msg, T, useGT, useMessages } from "~/i18n";
import { cn } from "~/lib/utils";
import {
  applyThemeColorPreview,
  createVividThemeColors,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  themeIdFromName,
  updateThemeColorFamily,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeColorRole,
  type ThemeDefinition,
} from "~/themePalette";

import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
import { ThemeCssEditor } from "./ThemeCssEditor";
import {
  clearThemeInspectorHover,
  clearThemeInspectorHighlights,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "./themeInspector";

const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

type ThemeEditorColorFamily = Readonly<{
  id: string;
  label: string;
  role: ThemeColorRole;
  roles: ReadonlyArray<ThemeColorRole>;
}>;

const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  families: ReadonlyArray<ThemeEditorColorFamily>;
}> = [
  {
    id: "foundation",
    title: msg("Foundation"),
    families: [
      {
        id: "background",
        label: msg("Background"),
        role: "canvas",
        roles: ["canvas", "chrome", "toolbar"],
      },
      { id: "surface", label: msg("Surface"), role: "surface", roles: ["surface"] },
      {
        id: "raised-surface",
        label: msg("Raised surface"),
        role: "surfaceRaised",
        roles: ["surfaceRaised"],
      },
      {
        id: "overlay",
        label: msg("Overlay"),
        role: "surfaceOverlay",
        roles: ["surfaceOverlay"],
      },
      {
        id: "text",
        label: msg("Text"),
        role: "text",
        roles: ["text", "toolbarForeground", "toolbarControlForeground"],
      },
      {
        id: "muted-text",
        label: msg("Muted text"),
        role: "mutedForeground",
        roles: [
          "textMuted",
          "mutedForeground",
          "placeholder",
          "secondaryLabel",
          "iconMuted",
          "sidebarMutedForeground",
        ],
      },
      {
        id: "border",
        label: msg("Border"),
        role: "border",
        roles: ["border", "toolbarBorder", "sidebarBorder"],
      },
      { id: "input", label: msg("Input"), role: "input", roles: ["input"] },
    ],
  },
  {
    id: "brand-content",
    title: msg("Brand & content"),
    families: [
      {
        id: "subtle-surface",
        label: msg("Subtle surface"),
        role: "secondary",
        roles: ["secondary", "secondaryForeground", "muted", "toolbarControl"],
      },
      {
        id: "highlight-surface",
        label: msg("Highlight surface"),
        role: "accentSurface",
        roles: ["accentSurface", "accentSurfaceForeground", "toolbarControlHover"],
      },
      {
        id: "accent",
        label: msg("Accent"),
        role: "accent",
        roles: [
          "accent",
          "accentForeground",
          "focus",
          "update",
          "updateForeground",
          "updateSurface",
          "terminalCursor",
        ],
      },
      {
        id: "action",
        label: msg("Action"),
        role: "messageAction",
        roles: ["messageAction", "messageActionForeground", "messageActionHover"],
      },
      {
        id: "message-surface",
        label: msg("Message surface"),
        role: "messageSurface",
        roles: ["messageSurface", "messageForeground"],
      },
      {
        id: "code-surface",
        label: msg("Code surface"),
        role: "codeBackground",
        roles: ["codeBackground", "codeForeground"],
      },
    ],
  },
  {
    id: "search",
    title: msg("Search"),
    families: [
      {
        id: "search-matches",
        label: msg("Search matches"),
        role: "searchMatchBackground",
        roles: ["searchMatchBackground", "searchMatchForeground"],
      },
      {
        id: "current-match",
        label: msg("Current match"),
        role: "searchMatchActiveBackground",
        roles: ["searchMatchActiveBackground", "searchMatchActiveForeground"],
      },
    ],
  },
  {
    id: "context",
    title: msg("Context"),
    families: [
      {
        id: "sidebar-background",
        label: msg("Sidebar background"),
        role: "sidebar",
        roles: ["sidebar", "sidebarForeground"],
      },
      {
        id: "sidebar-controls",
        label: msg("Sidebar controls"),
        role: "sidebarControlSurface",
        roles: ["sidebarControlSurface"],
      },
      {
        id: "sidebar-selection",
        label: msg("Sidebar selection"),
        role: "sidebarRowSelected",
        roles: ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"],
      },
      {
        id: "terminal-background",
        label: msg("Terminal background"),
        role: "terminalBackground",
        roles: [
          "terminalBackground",
          "terminalForeground",
          "terminalSelection",
          "terminalScrollbar",
          "terminalScrollbarHover",
        ],
      },
    ],
  },
  {
    id: "status",
    title: msg("Status"),
    families: [
      {
        id: "error",
        label: msg("Error"),
        role: "error",
        roles: ["error", "errorForeground", "errorSurface"],
      },
      {
        id: "warning",
        label: msg("Warning"),
        role: "warning",
        roles: ["warning", "warningForeground", "warningSurface"],
      },
    ],
  },
];

const THEME_EDITOR_COLOR_FAMILIES = THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families);
const THEME_EDITOR_COLOR_FAMILY_BY_ROLE = new Map(
  THEME_EDITOR_COLOR_FAMILIES.flatMap((family) =>
    family.roles.map((role) => [role, family] as const),
  ),
);

function getThemeEditorColorFamily(role: ThemeColorRole): ThemeEditorColorFamily | null {
  return THEME_EDITOR_COLOR_FAMILY_BY_ROLE.get(role) ?? null;
}

function themeEditorRoleLabel(
  role: ThemeColorRole,
  resolve: (message: string, values?: Record<string, unknown>) => string = msg,
): string {
  const family = getThemeEditorColorFamily(role);
  return family ? resolve(family.label) : getThemeRoleLabel(role, resolve);
}

type ThemeEditorColors = ThemeColors;
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
}

function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
}

function getManagedEditorColors(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): ThemeEditorColors {
  const defaults = getStandardThemeColors(appearance);
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

const PANEL_MARGIN = 8;
const PANEL_MIN_WIDTH = 280;
const PANEL_MIN_HEIGHT = 220;

/** Leave room for the scrollable body and both action rows when the editor is expanded. */
export function clampPanelPosition(
  viewport: { readonly width: number; readonly height: number },
  x: number,
  y: number,
  width: number,
  minimized: boolean,
) {
  const maxX = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN);
  const minimumHeight = minimized ? 48 : PANEL_MIN_HEIGHT;
  const maxY = Math.max(PANEL_MARGIN, viewport.height - minimumHeight - PANEL_MARGIN);
  return {
    x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
    y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
  };
}

const readWindowViewport = () => ({ width: window.innerWidth, height: window.innerHeight });

/** Local replacement for T3's `useViewportSize` hook (Burnrate does not own a copy). */
function useViewportSize(): { readonly width: number; readonly height: number } {
  const [viewport, setViewport] = useState(readWindowViewport);
  useEffect(() => {
    const onResize = () => setViewport(readWindowViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return viewport;
}

function themeEditorErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

/**
 * When a new theme's name matches an existing one, a single-appearance merge target leaves only
 * the opposite appearance free. Returns that appearance, or null when no switch is needed — in
 * particular for a two-appearance merge target, where both palettes are already taken.
 */
export function mergedAppearanceFor(
  takenAppearances: ReadonlyArray<ThemeAppearance>,
  activeAppearance: ThemeAppearance,
): ThemeAppearance | null {
  if (takenAppearances.length !== 1 || !takenAppearances.includes(activeAppearance)) return null;
  return takenAppearances[0] === "light" ? "dark" : "light";
}

// Kept out of the component: the compiler cannot lower a throw inside try/catch.
function retireMergedTheme(retired: ThemeDefinition, mergeTarget: ThemeDefinition) {
  try {
    removeCustomTheme(retired.id);
  } catch (cause) {
    // Restore the pre-merge target on retirement failure; leaving the persisted merge would collide on retry.
    try {
      updateCustomTheme(mergeTarget);
    } catch {
      /* best effort */
    }
    throw cause;
  }
}

export function ThemeEditorPanel({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
  restoreTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  seedTheme?: ThemeDefinition | null;
  seedName?: string | undefined;
  restoreTheme: () => void;
}) {
  const messages = useMessages();
  const gt = useGT();
  const isEditing = editingTheme !== null;
  const [name, setName] = useState("");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );
  const [simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance] = useState<
    Record<ThemeAppearance, boolean>
  >({ light: false, dark: false });
  const [shouldRegenerateGuidedColors, setShouldRegenerateGuidedColors] = useState(false);
  const [css, setCss] = useState("");
  const [cssOpen, setCssOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);
  // The rendered width is CSS-sized unless the user resized the panel, so the position
  // remembers the width measured at the last drag or resize.
  const [position, setPosition] = useState<{ x: number; y: number; width: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const colorEditSnapshotRef = useRef<{
    colorsByAppearance: ThemeEditorColorsByAppearance;
    simpleColorsDirtyByAppearance: Record<ThemeAppearance, boolean>;
    shouldRegenerateGuidedColors: boolean;
  } | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number; width: number } | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  // Seed during render so the first open frame cannot preview the previous session's colors.
  const [seededOpen, setSeededOpen] = useState(false);
  if (seededOpen !== open) {
    setSeededOpen(open);
    if (open) {
      const sourceTheme = editingTheme ?? seedTheme ?? null;
      const nextColors = getThemeEditorColorsByAppearance();
      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;
      if (sourceTheme) {
        nextColors[sourceTheme.appearance] = { ...sourceTheme.colors };
        for (const appearance of ["light", "dark"] as const) {
          const variantColors = sourceTheme.variants?.[appearance];
          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? seedName ?? "");
      setActiveAppearance(nextAppearance);
      // Open unmanaged themes in advanced mode to preserve imported or hand-tuned colors.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setShouldRegenerateGuidedColors(sourceTheme !== null && sourceTheme.managed !== true);
      setColorsByAppearance(nextColors);
      setCss(sourceTheme?.css ?? "");
      setCssOpen(Boolean(sourceTheme?.css));
      setSelectedRole(null);
      setUsageCount(null);
      setIsInspecting(false);
      setError(null);
    }
  }

  const nameTargetId = themeIdFromName(name);
  const normalizedName = name.trim().toLowerCase();
  const mergeTarget =
    normalizedName === ""
      ? null
      : (getCustomThemes().find(
          (theme) =>
            theme.id !== editingTheme?.id &&
            (theme.id === nameTargetId || theme.label.trim().toLowerCase() === normalizedName),
        ) ?? null);
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  // A merge keeps the target's CSS when this draft has none.
  const cssForSave = css.trim() ? css : (mergeTarget?.css ?? "");
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null;

  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return appearance === "light"
        ? gt("“{label}” has no light palette. Create a theme with the same name to add one.", {
            label: editingTheme?.label,
          })
        : gt("“{label}” has no dark palette. Create a theme with the same name to add one.", {
            label: editingTheme?.label,
          });
    }
    if (!isEditing && takenAppearances.includes(appearance)) {
      return appearance === "light"
        ? gt("“{label}” already has a light palette.", { label: mergeTarget?.label })
        : gt("“{label}” already has a dark palette.", { label: mergeTarget?.label });
    }
    return null;
  };

  const mergeKey =
    isEditing || mergeTarget === null ? null : `${mergeTarget.id}:${takenAppearances.join(",")}`;
  // Keyed on the merge target, not run during render: a render-phase setState here was the same
  // fragile pattern that produced the UsagePage loop. A ref (not state) keeps the guard stable
  // across StrictMode's double-invoked effects.
  const appliedMergeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (appliedMergeKeyRef.current === mergeKey) return;
    appliedMergeKeyRef.current = mergeKey;
    const nextAppearance = mergeKey === null ? null : mergedAppearanceFor(takenAppearances, activeAppearance);
    if (nextAppearance !== null) setActiveAppearance(nextAppearance);
  }, [mergeKey, takenAppearances, activeAppearance]);

  // Applies the edited colors to the document as a live theme preview while the editor is open.
  // This never writes settings: the palette lives on <html> inline until the panel closes.
  useEffect(() => {
    if (!open) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance, cssForSave);
  }, [activeAppearance, colorsByAppearance, cssForSave, open]);

  // Restores the document theme when the editor closes or unmounts (Cancel/Esc/X all end here).
  useEffect(() => {
    if (!open) return;
    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

  const updateColor = (role: ThemeColorRole, value: string) => {
    setColorsByAppearance((current) => {
      const nextColors = { ...current[activeAppearance], [role]: value };
      const shouldManageColors =
        !isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value);

      return {
        ...current,
        [activeAppearance]: isAdvanced
          ? updateThemeColorFamily(activeAppearance, current[activeAppearance], role, value)
          : shouldManageColors
            ? getManagedEditorColors(activeAppearance, nextColors)
            : nextColors,
      };
    });
    if (!isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value)) {
      setSimpleColorsDirtyByAppearance((current) => ({
        ...current,
        [activeAppearance]: true,
      }));
    }
    if (isAdvanced) setShouldRegenerateGuidedColors(true);
  };

  // A color edit also rewrites derived roles, so cancelling restores the whole snapshot rather than
  // replaying the previous value through updateColor.
  const startColorEdit = () => {
    colorEditSnapshotRef.current = {
      colorsByAppearance,
      simpleColorsDirtyByAppearance,
      shouldRegenerateGuidedColors,
    };
  };

  const cancelColorEdit = () => {
    const snapshot = colorEditSnapshotRef.current;
    colorEditSnapshotRef.current = null;
    if (!snapshot) return;
    setColorsByAppearance(snapshot.colorsByAppearance);
    setSimpleColorsDirtyByAppearance(snapshot.simpleColorsDirtyByAppearance);
    setShouldRegenerateGuidedColors(snapshot.shouldRegenerateGuidedColors);
  };

  const selectThemeRole = (role: ThemeColorRole, reveal = false) => {
    const visibleRole = getThemeEditorColorFamily(role)?.role ?? role;
    setSelectedRole(visibleRole);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(visibleRole)) {
      setIsAdvanced(true);
      setRoleQuery("");
    }
    if (!reveal) return;

    requestAnimationFrame(() => {
      panelRef.current?.querySelector(`[data-theme-color-role="${visibleRole}"]`)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "nearest",
      });
    });
  };

  const toggleThemeRole = (role: ThemeColorRole) => {
    setSelectedRole((current) => (current === role ? null : role));
  };

  const clearInspectorSelection = () => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  };

  const selectedHighlightRoles = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.roles ?? [selectedRole])
      : THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)
        ? THEME_COLOR_ROLES.filter(
            (role) =>
              colorsByAppearance[activeAppearance][role].trim().toLowerCase() ===
              colorsByAppearance[activeAppearance][selectedRole].trim().toLowerCase(),
          )
        : [selectedRole]
    : [];
  const selectedHighlightRolesKey = selectedHighlightRoles.join(",");

  // Highlights role usage in the DOM, refreshed by a MutationObserver and resize and scroll listeners.
  useEffect(() => {
    clearThemeInspectorHighlights();
    if (!open || selectedRole === null || isInspecting) return;

    const highlightedRoles = selectedHighlightRolesKey.split(",") as Array<ThemeColorRole>;
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // Each refresh snapshots the whole tree twice; throttle streaming and virtualization mutations.
    const MIN_REFRESH_INTERVAL_MS = 500;
    let refreshFrame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = performance.now();
    const scheduleRefresh = () => {
      if (refreshFrame !== null || refreshTimer !== null) return;
      const wait = Math.max(0, MIN_REFRESH_INTERVAL_MS - (performance.now() - lastRefreshAt));
      const run = () => {
        refreshFrame = null;
        refreshTimer = null;
        lastRefreshAt = performance.now();
        refreshHighlights();
      };
      if (wait === 0) refreshFrame = requestAnimationFrame(run);
      else refreshTimer = setTimeout(run, wait);
    };
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            (mutation.target.closest("#theme-inspector-spotlight") ||
              mutation.target.closest("[data-theme-editor-panel]")),
        )
      ) {
        return;
      }
      scheduleRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let spotlightFrame: number | null = null;
    const scheduleSpotlightRefresh = () => {
      if (spotlightFrame !== null) return;
      spotlightFrame = requestAnimationFrame(() => {
        spotlightFrame = null;
        refreshThemeInspectorSpotlight();
      });
    };
    window.addEventListener("resize", scheduleSpotlightRefresh);
    window.addEventListener("scroll", scheduleSpotlightRefresh, true);
    return () => {
      observer.disconnect();
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame);
      window.removeEventListener("resize", scheduleSpotlightRefresh);
      window.removeEventListener("scroll", scheduleSpotlightRefresh, true);
      clearThemeInspectorHighlights();
      setUsageCount(null);
    };
  }, [isInspecting, open, selectedHighlightRolesKey, selectedRole]);

  // Document pointer, click and key listeners that drive the inspect-mode hover overlay.
  useEffect(() => {
    if (!open || !isInspecting) {
      clearThemeInspectorHover();
      return;
    }

    let shouldDisarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;
    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };
    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(inspection, themeEditorRoleLabel(inspection.role, messages));
    };
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();
        return;
      }

      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);
      if (utilityInspection) {
        showInspection(utilityInspection);
        return;
      }

      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);
        if (inspection) showInspection(inspection);
      }, 140);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();
      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      selectThemeRole(inspection.role, true);
      shouldDisarmAfterClick = true;
    };
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (shouldDisarmAfterClick) setIsInspecting(false);
      shouldDisarmAfterClick = false;
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc leaves inspection only; Settings must not see it and close too.
      event.preventDefault();
      event.stopImmediatePropagation();
      clearHover();
      clearInspectorSelection();
    };
    const refreshHover = () => {
      if (!hoverInspection || hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null;
        if (hoverInspection) {
          showThemeInspectorHover(hoverInspection, themeEditorRoleLabel(hoverInspection.role, messages));
        }
      });
    };
    const clearHoverOnScroll = () => clearHover();

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHoverOnScroll, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHoverOnScroll, true);
      clearHoverTimer();
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [isInspecting, messages, open, selectThemeRole]);

  const handleAdvancedChange = (checked: boolean) => {
    setIsAdvanced(checked);
    if (checked) return;
    if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) {
      setSelectedRole(null);
    }
    if (!shouldRegenerateGuidedColors) return;

    const managedAppearances: ReadonlyArray<ThemeAppearance> =
      editingTheme && getThemeModes(editingTheme).length > 1
        ? ["light", "dark"]
        : [activeAppearance];
    setSimpleColorsDirtyByAppearance((current) => {
      const next = { ...current };
      for (const appearance of managedAppearances) next[appearance] = true;
      return next;
    });
    setColorsByAppearance((current) => {
      const next = { ...current };
      for (const appearance of managedAppearances) {
        next[appearance] = getManagedEditorColors(appearance, current[appearance]);
      }
      return next;
    });
    setShouldRegenerateGuidedColors(false);
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      setError(gt("Name your theme first."));
      return;
    }

    if (mergeTarget?.css && css.trim() && mergeTarget.css !== css) {
      setError(
        gt("“{label}” has different custom CSS. Use the same CSS or pick another name.", {
          label: mergeTarget.label,
        }),
      );
      return;
    }

    try {
      const colorsForSave = !isAdvanced
        ? {
            light: simpleColorsDirtyByAppearance.light
              ? getManagedEditorColors("light", colorsByAppearance.light)
              : colorsByAppearance.light,
            dark: simpleColorsDirtyByAppearance.dark
              ? getManagedEditorColors("dark", colorsByAppearance.dark)
              : colorsByAppearance.dark,
          }
        : colorsByAppearance;

      let savedTheme: ThemeDefinition;
      let mergedAppearance: ThemeAppearance | null = null;
      let retiredTheme: ThemeDefinition | null = null;
      if (editingTheme && mergeTarget) {
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));
        if (collision) {
          setError(
            collision === "light"
              ? gt("“{label}” already has a light palette. Pick another name.", {
                  label: mergeTarget.label,
                })
              : gt("“{label}” already has a dark palette. Pick another name.", {
                  label: mergeTarget.label,
                }),
          );
          return;
        }
        mergedAppearance = editedModes[0] ?? null;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])),
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
            ...(cssForSave ? { css: cssForSave } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
        retiredTheme = editingTheme;
        retireMergedTheme(editingTheme, mergeTarget);
      } else if (editingTheme) {
        const baseAppearance = editingTheme.appearance;
        const variantAppearance = baseAppearance === "light" ? "dark" : "light";
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: editingTheme.id,
            name,
            appearance: baseAppearance,
            colors: colorsForSave[baseAppearance],
            ...(getThemeModes(editingTheme).length > 1
              ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } }
              : {}),
            ...(isAdvanced ? {} : { managed: true }),
            ...(cssForSave ? { css: cssForSave } : {}),
          }),
          ...(editingTheme.collection ? { collection: editingTheme.collection } : {}),
        });
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(
            gt("“{label}” already has light and dark palettes. Pick another name.", {
              label: mergeTarget.label,
            }),
          );
          return;
        }
        mergedAppearance = activeAppearance;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              [activeAppearance]: colorsForSave[activeAppearance],
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
            ...(cssForSave ? { css: cssForSave } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
      } else {
        savedTheme = installCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            name,
            appearance: activeAppearance,
            colors: colorsForSave[activeAppearance],
            ...(isAdvanced ? {} : { managed: true }),
            ...(cssForSave ? { css: cssForSave } : {}),
          }),
        );
      }
      if (
        !onSaved(savedTheme, {
          created: editingTheme === null && mergedAppearance === null,
          ...(mergedAppearance ? { mergedAppearance } : {}),
        })
      ) {
        if (!editingTheme && mergedAppearance === null) {
          try {
            removeCustomTheme(savedTheme.id);
          } catch {
            /* best effort */
          }
        } else if (mergeTarget && mergedAppearance !== null) {
          try {
            updateCustomTheme(mergeTarget);
            if (retiredTheme) installCustomTheme(retiredTheme);
          } catch {
            /* best effort */
          }
        }
        setError(gt("Theme saved, but it could not be made active. Try again."));
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(
        themeEditorErrorMessage(
          cause,
          isEditing ? gt("Could not save the theme.") : gt("Could not create the theme."),
        ),
      );
    }
  };

  const renderNameField = () => (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm text-foreground">
        <T>Theme name</T>
      </span>
      <Input
        autoFocus
        size="sm"
        onChange={(event) => {
          setName(event.currentTarget.value);
          setError(null);
        }}
        placeholder={isEditing ? gt("Theme name") : gt("e.g. Aurora")}
        value={name}
      />
    </label>
  );

  const renderAppearanceButton = (appearance: ThemeAppearance) => {
    const lockReason = appearanceLockReason(appearance);
    // Use aria-disabled so locked modes remain hoverable for explanatory tooltips.
    const button = (
      <Toggle aria-disabled={lockReason !== null} value={appearance}>
        {appearance === "light" ? gt("Light") : gt("Dark")}
      </Toggle>
    );
    if (lockReason === null) return button;
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup>{lockReason}</TooltipPopup>
      </Tooltip>
    );
  };

  const renderAppearanceButtons = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm text-foreground">
        <T>Appearance</T>
      </span>
      <ToggleGroup
        aria-label={gt("Theme appearance")}
        variant="segmented"
        value={[activeAppearance]}
        onValueChange={(next) => {
          const appearance = next[0];
          if (
            (appearance === "light" || appearance === "dark") &&
            appearanceLockReason(appearance) === null
          ) {
            setActiveAppearance(appearance);
          }
        }}
      >
        {renderAppearanceButton("light")}
        {renderAppearanceButton("dark")}
      </ToggleGroup>
    </div>
  );

  const renderColorsHeader = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
      <div>
        <h3 className="text-sm font-medium">
          <T>Colors</T>
        </h3>
        {isAdvanced ? null : (
          <p className="text-xs text-muted-foreground">
            <T>Two colors, rest derived</T>
          </p>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-3">
        {isAdvanced ? (
          <Input
            aria-label={gt("Filter colors")}
            className="min-w-0 flex-1"
            onChange={(event) => setRoleQuery(event.currentTarget.value)}
            placeholder={gt("Filter colors")}
            size="sm"
            value={roleQuery}
          />
        ) : null}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 pt-0.5 text-sm text-foreground">
          <span>
            <T>Advanced</T>
          </span>
          <Switch
            aria-label={gt("Use advanced theme colors")}
            checked={isAdvanced}
            onCheckedChange={(checked) => handleAdvancedChange(Boolean(checked))}
          />
        </label>
      </div>
    </div>
  );

  const renderRoleFields = (
    families: ReadonlyArray<ThemeEditorColorFamily>,
    gridClassName = "grid gap-2 sm:grid-cols-2",
  ) => (
    <div className={gridClassName}>
      {families.map((family) => (
        <ThemeColorField
          key={family.id}
          label={messages(family.label)}
          onChange={updateColor}
          onEditCancel={cancelColorEdit}
          onEditStart={startColorEdit}
          onSelect={selectThemeRole}
          onToggleSelected={toggleThemeRole}
          role={family.role}
          selected={selectedRole === family.role}
          value={colorsByAppearance[activeAppearance][family.role]}
        />
      ))}
    </div>
  );

  const renderColorFields = () => {
    const query = roleQuery.trim().toLowerCase();
    const groups = THEME_EDITOR_ROLE_GROUPS.map((group) => ({
      ...group,
      families: group.families.filter(
        (family) =>
          !query ||
          [messages(family.label), ...family.roles.map((role) => getThemeRoleLabel(role, messages))]
            .join(" ")
            .toLowerCase()
            .includes(query),
      ),
    })).filter((group) => group.families.length > 0);
    return isAdvanced ? (
      <div className="space-y-6">
        {groups.map((group) => (
          <section className="space-y-3" key={group.id}>
            <h4 className="text-sm font-medium text-foreground">{messages(group.title)}</h4>
            {renderRoleFields(group.families, "grid gap-1")}
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>No matches.</T>
          </p>
        ) : null}
      </div>
    ) : (
      <div className="grid gap-1">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
          <ThemeColorField
            key={role}
            onChange={updateColor}
            onEditCancel={cancelColorEdit}
            onEditStart={startColorEdit}
            onSelect={selectThemeRole}
            onToggleSelected={toggleThemeRole}
            role={role}
            label={role === "canvas" ? gt("Background") : gt("Accent")}
            selected={selectedRole === role}
            value={colorsByAppearance[activeAppearance][role]}
          />
        ))}
      </div>
    );
  };

  // Geometry is stored as the user left it and fitted to the current viewport here, so a
  // window that shrinks and grows back returns the panel to where it was.
  const viewport = useViewportSize();
  const shownSize = size && {
    width: Math.max(PANEL_MIN_WIDTH, Math.min(size.width, viewport.width - PANEL_MARGIN * 2)),
    height: Math.max(PANEL_MIN_HEIGHT, Math.min(size.height, viewport.height - PANEL_MARGIN * 2)),
  };
  const shownPosition =
    position && clampPanelPosition(viewport, position.x, position.y, shownSize?.width ?? position.width, isMinimized);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = {
      dx: event.clientX - rect.x,
      dy: event.clientY - rect.y,
      width: rect.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    const next = clampPanelPosition(
      readWindowViewport(),
      event.clientX - offset.dx,
      event.clientY - offset.dy,
      offset.width,
      isMinimized,
    );
    setPosition({ ...next, width: offset.width });
  };

  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    // Resize from where the panel is drawn, so a position clamped after the window shrank, or bottom-right
    // parking, can't make the top-left corner slide.
    const next = clampPanelPosition(readWindowViewport(), rect.x, rect.y, rect.width, isMinimized);
    setPosition({ ...next, width: rect.width });
    resizeStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const maxWidth = Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_MARGIN - start.left);
    const maxHeight = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_MARGIN - start.top);
    setSize({
      width: Math.min(
        Math.max(start.width + event.clientX - start.pointerX, PANEL_MIN_WIDTH),
        maxWidth,
      ),
      height: Math.min(
        Math.max(start.height + event.clientY - start.pointerY, PANEL_MIN_HEIGHT),
        maxHeight,
      ),
    });
  };

  const endResize = () => {
    resizeStartRef.current = null;
  };

  return (
    <div
      aria-label={isEditing ? gt("Edit theme") : gt("Create theme")}
      className={cn(
        "fixed z-[110] flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background text-popover-foreground shadow-lg/5",
        position === null && "bottom-4 right-4",
        isMinimized && "max-h-none",
      )}
      data-theme-editor-panel=""
      data-settings-overlay=""
      onKeyDown={(event) => {
        // Popups opened from the editor are portaled outside it and handle their own Esc.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.stopPropagation();
        onOpenChange(false);
      }}
      ref={panelRef}
      role="dialog"
      style={{
        ...(shownPosition ? { left: shownPosition.x, top: shownPosition.y } : {}),
        ...(shownSize ? { width: shownSize.width } : {}),
        ...(shownSize && !isMinimized ? { height: shownSize.height } : {}),
        ...(!isMinimized && (shownSize || shownPosition)
          ? { maxHeight: `calc(100dvh - ${(shownPosition?.y ?? PANEL_MARGIN) + PANEL_MARGIN}px)` }
          : {}),
      }}
    >
      <div
        className="flex shrink-0 cursor-grab touch-none select-none items-center gap-1 border-b border-border px-4 py-3 active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={endDrag}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 truncate text-sm font-medium">
            {isEditing ? gt("Edit theme") : gt("Create theme")}
          </h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {isInspecting
                ? gt("Select an element · Esc to cancel")
                : selectedRole
                  ? gt("{label} · {count, plural, one {{count} use} other {{count} uses}}", {
                      label: isAdvanced
                        ? themeEditorRoleLabel(selectedRole, messages)
                        : getThemeRoleLabel(selectedRole, messages),
                      count: usageCount ?? 0,
                    })
                  : gt("Select a color below")}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={
                  isInspecting ? gt("Cancel inspecting app colors") : gt("Inspect app colors")
                }
                aria-pressed={isInspecting}
                size="xs"
                variant={isInspecting ? "secondary" : "ghost"}
                onClick={() => {
                  if (isInspecting) {
                    clearInspectorSelection();
                    return;
                  }
                  setIsInspecting(true);
                }}
              >
                <MousePointer2Icon />
                {isInspecting ? gt("Cancel") : gt("Inspect")}
              </Button>
            }
          />
          <TooltipPopup data-theme-editor-panel="">
            {isInspecting ? gt("Cancel and clear the selection") : gt("Pick a color from the app")}
          </TooltipPopup>
        </Tooltip>
        <Button
          aria-label={isMinimized ? gt("Expand the theme editor") : gt("Minimize the theme editor")}
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMinimized(!isMinimized)}
        >
          {isMinimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          aria-label={gt("Close the theme editor")}
          size="icon-xs"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </div>

      {isMinimized ? null : (
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain scroll-py-4 px-4 py-4 [scrollbar-gutter:stable]">
            {renderNameField()}
            {error ? (
              <p aria-live="polite" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
            {renderAppearanceButtons()}
            <div className="space-y-3">
              {renderColorsHeader()}
              {renderColorFields()}
            </div>
            <div className="space-y-2">
              <Button
                aria-expanded={cssOpen}
                size="xs"
                variant="ghost"
                onClick={() => setCssOpen(!cssOpen)}
              >
                {cssOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <T>Custom CSS</T>
              </Button>
              {cssOpen ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Saved with this theme and included when you export it. Web and desktop only.
                      Rules that load remote files are ignored.
                    </T>
                  </p>
                  <ThemeCssEditor value={css} onChange={setCss} />
                </>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              <T>Cancel</T>
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                mergeTarget ? (
                  gt("Merge into “{label}”", { label: mergeTarget.label })
                ) : (
                  gt("Save changes")
                )
              ) : mergeTarget ? (
                <>
                  <PlusIcon />
                  {activeAppearance === "light" ? gt("Add light palette") : gt("Add dark palette")}
                </>
              ) : (
                <>
                  <PaintbrushIcon />
                  <T>Create theme</T>
                </>
              )}
            </Button>
          </div>
          <div
            aria-hidden
            className="absolute bottom-0 right-0 z-10 flex size-5 cursor-se-resize touch-none select-none items-end justify-end p-1 text-muted-foreground/70"
            onPointerCancel={endResize}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
          >
            <svg
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.2"
              viewBox="0 0 8 8"
            >
              <path d="M7 1 1 7M7 4.5 4.5 7" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
