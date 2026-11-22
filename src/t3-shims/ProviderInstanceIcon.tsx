/**
 * Adapter for T3's `components/chat/ProviderInstanceIcon`. The Usage dialogs only
 * pass driverKind/displayName/iconClassName, so this reproduces T3's markup for
 * that case (including the wrapper classes and initials fallback) without the
 * package-icon, ACP-registry and badge machinery Burnrate does not have.
 */

import { type CSSProperties, memo } from "react";

import {
  AnthropicIcon,
  AntigravityIcon,
  ClaudeAI,
  type Icon,
  MistralIcon,
  OllamaIcon,
  OpenAI,
  OpenRouterIcon,
} from "~/components/Icons";
import { cn } from "~/lib/utils";
import { BRAND_ICONS } from "~/providers/brandIcons";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<string, Icon>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  antigravity: AntigravityIcon,
  mistral: MistralIcon,
  openai: OpenAI,
  anthropic: AnthropicIcon,
  openrouter: OpenRouterIcon,
  ollama: OllamaIcon,
};

/** Mirrors T3's `providerInstanceInitials` (punctuation splits words, quotes don't). */
function providerInstanceInitials(label: string): string {
  const words = label
    .replace(/[^\P{P}'’]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

interface ProviderInstanceIconProps {
  driverKind: string;
  displayName: string;
  accentColor?: string | undefined;
  size?: "default" | "compact";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  indicatorBackground?: string;
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(
  props: ProviderInstanceIconProps,
) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? BRAND_ICONS[props.driverKind] ?? null;
  const accentColor = props.accentColor?.trim();
  const normalizedAccent =
    accentColor !== undefined && /^#[0-9a-fA-F]{6}$/u.test(accentColor) ? accentColor : undefined;
  const accentStyle = normalizedAccent
    ? ({ "--provider-accent": normalizedAccent } as CSSProperties)
    : undefined;
  const iconClassName = cn(props.size === "compact" && "size-3.5", props.iconClassName);

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={normalizedAccent}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
    </span>
  );
});
