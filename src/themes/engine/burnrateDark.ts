/**
 * Burnrate's dark default, id `burnrate-dark` (the user's "test" palette).
 *
 * This is the content that used to live in the hand-written `src/theme-dark.css`.
 * It is kept as a ThemeDefinition so the runtime palette pipeline can derive/apply
 * the exact same 61 colors instead of shipping a second, static stylesheet.
 * Package 24 registers it from `src/themes/presets/burnrate-dark.ts`; importing it
 * here already makes the default dark id resolvable.
 *
 * Seeds: appearance dark, canvas #181818, accent #ffffff (docs/THEME.md).
 */
import type { ThemeDefinition } from "~/shared/themePalettes";

export const BURNRATE_DARK_THEME_ID = "burnrate-dark";

export const burnrateDark: ThemeDefinition = {
  id: BURNRATE_DARK_THEME_ID,
  label: "edge of night",
  appearance: "dark",
  managed: true,
  colors: {
    canvas: "oklch(0.209036 0 0)",
    chrome: "oklch(0.209036 0 0)",
    toolbar: "oklch(0.209036 0 0)",
    toolbarForeground: "oklch(0.949119 0 0)",
    toolbarBorder: "oklch(0.349036 0 0)",
    toolbarControl: "oklch(0.299036 0.0104 89.876)",
    toolbarControlForeground: "oklch(0.949119 0 0)",
    toolbarControlHover: "oklch(0.349036 0.0128 89.876)",
    surface: "oklch(0.224036 0.008 89.876)",
    surfaceRaised: "oklch(0.259036 0.008 89.876)",
    surfaceOverlay: "oklch(0.284036 0.008 89.876)",
    text: "oklch(0.949119 0 0)",
    textMuted: "oklch(0.63047 0 0)",
    border: "oklch(0.369036 0 0)",
    input: "oklch(0.419036 0 0)",
    focus: "oklch(1 0 0)",
    accent: "oklch(1 0 0)",
    accentForeground: "oklch(0.222003 0.03479 328.979)",
    secondary: "oklch(0.309036 0 0)",
    secondaryForeground: "oklch(0.95 0 0)",
    muted: "oklch(0.269036 0 0)",
    mutedForeground: "oklch(0.645769 0 0)",
    placeholder: "oklch(0.638795 0.003624 97.335)",
    secondaryLabel: "oklch(0.63047 0 0)",
    iconMuted: "oklch(0.63047 0 0)",
    error: "oklch(0.655108 0.221148 23.473)",
    errorForeground: "oklch(0.702184 0.189226 22.228)",
    errorSurface: "oklch(0.278509 0.046369 17.413)",
    warning: "oklch(0.772406 0.172798 65.367)",
    warningForeground: "oklch(0.829017 0.171221 81.038)",
    warningSurface: "oklch(0.308631 0.044837 76.593)",
    update: "oklch(1 0 0)",
    updateForeground: "oklch(0.95 0 0)",
    updateSurface: "oklch(0.349036 0 0)",
    accentSurface: "oklch(0.339036 0 0)",
    accentSurfaceForeground: "oklch(0.95 0 0)",
    messageSurface: "oklch(0.369036 0 0)",
    messageForeground: "oklch(0.95 0 0)",
    messageAction: "oklch(0.850302 0.05972 139.757)",
    messageActionForeground: "oklch(0.222003 0.03479 328.979)",
    messageActionHover: "oklch(0.91 0.06 139.876)",
    codeBackground: "oklch(0.244036 0.0064 89.876)",
    codeForeground: "oklch(0.949119 0 0)",
    searchMatchBackground: "oklch(0.427608 0 0)",
    searchMatchForeground: "oklch(0.990339 0.008411 325.64)",
    searchMatchActiveBackground: "oklch(0.609986 0 0)",
    searchMatchActiveForeground: "oklch(0.222003 0.03479 328.979)",
    sidebar: "oklch(0.254036 0.0112 89.876)",
    sidebarForeground: "oklch(0.95 0 0)",
    sidebarMutedForeground: "oklch(0.659463 0.003679 80.724)",
    sidebarControlSurface: "oklch(0.309036 0.012 89.876)",
    sidebarRowHover: "oklch(0.289036 0 0)",
    sidebarRowActive: "oklch(0.329036 0 0)",
    sidebarRowSelected: "oklch(0.349036 0 0)",
    sidebarBorder: "oklch(0.379036 0 0)",
    terminalBackground: "oklch(0.209036 0 0)",
    terminalForeground: "oklch(0.949119 0 0)",
    terminalCursor: "oklch(1 0 0)",
    terminalSelection: "oklch(0.389036 0 0)",
    terminalScrollbar: "oklch(0.429036 0.008 89.876)",
    terminalScrollbarHover: "oklch(0.509036 0.008 89.876)",
  },
};

/** Alias used by package 24 when re-exporting from `src/themes/presets/burnrate-dark.ts`. */
export const BURNRATE_DARK_THEME = burnrateDark;
