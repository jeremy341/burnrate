import type { LimitsAccount } from "../../src/contracts.ts";
import type { ProviderModule } from "../types.ts";

const base = "https://api.mistral.ai/v1/billing";

async function readOne(name: string, key: string): Promise<LimitsAccount> {
  const head = { id: name, driver: "mistral", label: name, displayName: name };
  const unavailable = (message: string): LimitsAccount => ({
    ...head,
    limits: {
      checkedAt: new Date().toISOString(),
      windows: [],
      unavailable: { reason: "probeFailed", message },
    },
  });
  try {
    const auth = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const [budget, sub] = await Promise.all([
      fetch(`${base}/budget`, { headers: auth, signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/subscription`, { headers: auth, signal: AbortSignal.timeout(8000) }).catch(
        () => null,
      ),
    ]);
    const body = (await budget.json().catch(() => null)) as {
      vibe_budget?: { usage_percentage?: number | string; reset_at?: string };
    } | null;
    const vb = body?.vibe_budget;
    const pct = Number(vb?.usage_percentage);
    if (!budget.ok || !vb || !Number.isFinite(pct)) {
      return unavailable(`Mistral budget unavailable (HTTP ${budget.status}).`);
    }
    const planName = sub?.ok
      ? ((await sub.json().catch(() => null)) as { plan_name?: string } | null)?.plan_name
      : undefined;
    const resets = vb.reset_at ? new Date(vb.reset_at) : null;
    return {
      ...head,
      ...(planName ? { plan: planName.charAt(0) + planName.slice(1).toLowerCase() } : {}),
      limits: {
        checkedAt: new Date().toISOString(),
        windows: [
          {
            id: "vibe-monthly",
            kind: "monthly",
            label: "Monthly",
            usedPercent: Math.max(0, Math.min(100, pct)),
            ...(resets && !Number.isNaN(resets.getTime())
              ? { resetsAt: resets.toISOString() }
              : {}),
          },
        ],
      },
    };
  } catch {
    return unavailable("Mistral budget request failed.");
  }
}

export const mistral: ProviderModule = {
  id: "mistral",
  label: "Mistral",
  color: "#fa520f",
  auth: "apiKey",
  read: (keys) => Promise.all(keys.list("mistral").map(({ name, key }) => readOne(name, key))),
};
