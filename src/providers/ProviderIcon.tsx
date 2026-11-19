import type { ComponentType, SVGProps } from "react";

import { cn } from "~/lib/utils";
import { AnthropicIcon, ClaudeAI, MistralIcon, OllamaIcon, OpenAI, OpenRouterIcon } from "~/components/Icons";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Brand marks by provider id. A provider without an entry shows its initials instead. */
const ICONS: Record<string, IconComponent> = {
  claudeAgent: ClaudeAI,
  anthropic: AnthropicIcon,
  codex: OpenAI,
  openai: OpenAI,
  mistral: MistralIcon,
  openrouter: OpenRouterIcon,
  ollama: OllamaIcon,
};

function initials(label: string): string {
  const words = label.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [words[0]?.[0], words[0]?.[1]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
}

export function ProviderIcon({
  driver,
  label,
  className,
  iconClassName,
}: {
  readonly driver: string;
  readonly label: string;
  readonly className?: string | undefined;
  readonly iconClassName?: string | undefined;
}) {
  const Icon = ICONS[driver];
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
          aria-hidden
        >
          {initials(label)}
        </span>
      )}
    </span>
  );
}
