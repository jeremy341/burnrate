import { useId, useState } from "react";

import { Input } from "~/components/ui/input";
import { useGT } from "~/i18n";
import { cn } from "~/lib/utils";

export type BoundedNumberResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false };

/**
 * Parse a typed number and clamp it into `[min, max]`. Anything that is not a finite number is
 * rejected (the caller keeps the previous value), so an emptied field never saves `0`.
 */
export function parseBoundedNumber(
  raw: string,
  min: number,
  max: number,
  { integer = true }: { integer?: boolean } = {},
): BoundedNumberResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false };
  const rounded = integer ? Math.round(parsed) : parsed;
  return { ok: true, value: Math.min(max, Math.max(min, rounded)) };
}

/**
 * A number input for settings: typing never fights the clamp (the old inputs snapped `1` to the
 * minimum on the first keystroke), the value commits on blur or Enter, Escape restores the saved
 * value, and an unusable entry is flagged instead of being silently replaced.
 */
export function SettingsNumberField({
  value,
  min,
  max,
  step = 1,
  integer = true,
  onCommit,
  ariaLabel,
  descriptionId,
  className,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  onCommit: (next: number) => void;
  ariaLabel: string;
  descriptionId?: string;
  className?: string;
  disabled?: boolean;
}) {
  const gt = useGT();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const invalid = draft !== null && !parseBoundedNumber(draft, min, max, { integer }).ok;

  const finish = () => {
    if (draft === null) return;
    const result = parseBoundedNumber(draft, min, max, { integer });
    setDraft(null);
    if (result.ok && result.value !== value) onCommit(result.value);
  };

  return (
    <div className={cn("w-24 max-w-full", className)}>
      <Input
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={[descriptionId, invalid ? errorId : undefined].filter(Boolean).join(" ") || undefined}
        aria-invalid={invalid || undefined}
        className="w-full"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape" && draft !== null) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {invalid ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive-foreground">
          {gt("Enter a number.")}
        </p>
      ) : null}
    </div>
  );
}
