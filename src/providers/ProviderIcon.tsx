import type { ComponentType, SVGProps } from "react";

import {
  AnthropicIcon,
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  KiroIcon,
  MistralIcon,
  OllamaIcon,
  OpenAI,
  OpenRouterIcon,
} from "~/components/Icons";
import { cn } from "~/lib/utils";
import { BRAND_ICONS } from "~/providers/brandIcons";
import { normalizeAccentColor, providerInitials } from "~/providers/presentation";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Brand marks by provider id. A provider without an entry shows its initials instead. */
const ICONS: Record<string, IconComponent> = {
  claudeAgent: ClaudeAI,
  anthropic: AnthropicIcon,
  "anthropic-admin": AnthropicIcon,
  codex: OpenAI,
  openai: OpenAI,
  "openai-admin": OpenAI,
  mistral: MistralIcon,
  openrouter: OpenRouterIcon,
  ollama: OllamaIcon,
  cursor: CursorIcon,
  kiro: KiroIcon,
  antigravity: AntigravityIcon,
};

/**
 * A provider mark. Definition ids without a brand asset get an initials tile, tinted with the
 * user's local accent when they picked one (`accent`), otherwise with the accent's default border.
 */
export function ProviderIcon({
  driver,
  label,
  className,
  iconClassName,
  accent,
}: {
  readonly driver: string;
  readonly label: string;
  readonly className?: string | undefined;
  readonly iconClassName?: string | undefined;
  /** Optional local accent colour (`#rrggbb`) for providers drawn as initials. */
  readonly accent?: string | undefined;
}) {
  const Icon = ICONS[driver] ?? BRAND_ICONS[driver];
  const color = normalizeAccentColor(accent);
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", className)}>
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", iconClassName)} aria-hidden />
      ) : (
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-md border bg-card text-3xs leading-none font-semibold text-foreground",
            iconClassName,
          )}
          style={color ? { borderColor: color, color } : undefined}
          aria-hidden
        >
          {providerInitials(label)}
        </span>
      )}
    </span>
  );
}
