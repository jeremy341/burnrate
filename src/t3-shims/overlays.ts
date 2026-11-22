/** Burnrate has no command palette or model picker, so usage shortcuts are never blocked by them. */

export function isCommandPaletteOpen(): boolean {
  return false;
}

export function isModelPickerOpen(): boolean {
  return false;
}
