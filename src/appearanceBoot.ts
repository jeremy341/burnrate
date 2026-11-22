/**
 * Side-effect module: paints the saved appearance as early as the module graph allows.
 *
 * `main.tsx` imports this FIRST. ES modules evaluate in import order, so the palette, `.dark` class
 * and fonts are applied before `App` and its (large) import graph is even evaluated, instead of after
 * it, which is what the old call at the bottom of `main.tsx` did. The inline script in
 * `index.html` still covers the very first frame (background only).
 */
import { startClientAppearance } from "./appearance";
// The fonts module starts itself on import (it is idempotent); import it here so that happens early
// and `main.tsx` does not need a second, redundant `startAppearanceFonts()` call.
import "./appearanceFonts";

startClientAppearance();
