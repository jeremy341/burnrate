/**
 * T3 shows an optional "ChatGPT shared usage" link when a Codex provider reports shared plans.
 * Burnrate reads a single local server and has no sharing flow, so the control is inert.
 */

export function ChatGptUsageButton(_props?: { readonly size?: string }): null {
  return null;
}

export function usesChatGptSharing(): boolean {
  return false;
}
