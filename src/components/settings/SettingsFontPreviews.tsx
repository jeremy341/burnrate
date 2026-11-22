/**
 * Inline font previews for Settings → Appearance (trimmed from T3's
 * `SettingsFontPreviews.tsx`). Burnrate only has an interface font and a
 * monospace font, so the prompt/terminal/diff previews are not ported.
 */
import type { CSSProperties } from "react";

import {
  appearanceFontStack,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
} from "~/appearanceFonts";
import { useGT } from "~/i18n";

function fontStyle(stack: string): CSSProperties {
  return { fontFamily: stack };
}

export function InterfaceFontPreview({ family }: { readonly family: string | null }) {
  const gt = useGT();
  const stack = appearanceFontStack(family, DEFAULT_SANS_FONT_STACK);
  return (
    <figure className="mt-1 mb-2 rounded-md bg-muted px-3 py-2">
      <figcaption className="sr-only">{gt("Interface font preview")}</figcaption>
      <div style={fontStyle(stack)} className="space-y-1.5 text-foreground">
        <p className="text-sm font-medium">{gt("Limits refresh every two minutes")}</p>
        <p className="text-xs text-muted-foreground">
          {gt("The quick brown fox jumps over the lazy dog. 0123456789 — Claude 27% used, resets in 3h 57m.")}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="rounded-md border border-border px-2 py-0.5 text-xs">{gt("Refresh now")}</span>
          <span className="text-xs text-muted-foreground">Fit &amp; finish · ÀÉÎÕÜ · 日本語</span>
        </div>
      </div>
    </figure>
  );
}

const MONO_PREVIEW = [
  "Session     27% left    resets in 3h 57m",
  "Weekly      42% left    resets in 5d 3h",
  "Processed   1,284,930 tokens",
  "Cost        $12.80",
].join("\n");

export function MonoFontPreview({ family }: { readonly family: string | null }) {
  const gt = useGT();
  const stack = appearanceFontStack(family, DEFAULT_MONO_FONT_STACK);
  return (
    <figure className="mt-1 mb-2 rounded-md bg-muted px-3 py-2">
      <figcaption className="sr-only">{gt("Monospace font preview")}</figcaption>
      <pre style={fontStyle(stack)} className="wrap-anywhere whitespace-pre-wrap text-xs leading-relaxed text-foreground">
        {MONO_PREVIEW}
      </pre>
    </figure>
  );
}
