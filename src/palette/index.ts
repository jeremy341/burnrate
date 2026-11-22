/** Public API for packages that want to add commands or drive the palette. */
export {
  dispatchPaletteAction,
  onOpenPalette,
  onPaletteAction,
  openPalette,
  OPEN_PALETTE_EVENT,
  PALETTE_ACTION_EVENT,
  type OpenPaletteDetail,
  type PaletteAction,
  type PaletteActionHandler,
} from "./actions";
export { filterCommands, fuzzyScore, groupCommands, scoreCommand } from "./fuzzy";
export {
  clearCommands,
  getCommands,
  hasCommand,
  registerCommand,
  registerCommands,
  subscribe,
  unregisterCommand,
} from "./registry";
export type { PaletteCommand, PaletteCommandGroup } from "./types";
export { useCommands } from "./useCommands";
