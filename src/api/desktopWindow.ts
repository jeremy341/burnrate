import { isDesktopShell } from "~/settings/environment";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke?: <T>(command: string) => Promise<T> };
};

function getTauriInternals() {
  return isDesktopShell() ? (window as TauriWindow).__TAURI_INTERNALS__ : undefined;
}

export function hasDesktopWindowControls(): boolean {
  return typeof getTauriInternals()?.invoke === "function";
}

async function invoke<T>(command: string): Promise<T> {
  const internals = getTauriInternals();
  if (typeof internals?.invoke !== "function") {
    throw new Error("Desktop window controls are unavailable");
  }
  return internals.invoke<T>(command);
}

export const desktopWindow = {
  minimize: () => invoke<void>("shell_minimize_main"),
  isMaximized: () => invoke<boolean>("shell_main_is_maximized"),
  toggleMaximize: () => invoke<boolean>("shell_toggle_main_maximize"),
  close: () => invoke<void>("shell_close_main"),
};
