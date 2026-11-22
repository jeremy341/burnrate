/**
 * Adapter for T3's `normalizeProviderAccentColor`
 * (`@t3tools/client-runtime/state/provider-instance-display`).
 *
 * Kept byte-for-byte in logic so the Usage components render accents exactly as upstream: only a
 * plain `#RRGGBB` value is accepted, everything else (named colors, `oklch(...)`, CSS variables)
 * falls back to the provider's bar color.
 */
export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}
