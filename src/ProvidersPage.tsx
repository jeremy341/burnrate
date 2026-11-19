import { useState } from "react";

import { api, type Loaded } from "~/api";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ProviderIcon } from "~/providers/ProviderIcon";
import type { ProviderInfo } from "~/contracts";

function KeyForm({ provider, onSaved }: { provider: ProviderInfo; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveKey(provider.id, name.trim(), apiKey.trim());
      setName("");
      setApiKey("");
      onSaved();
    } catch {
      setError("Could not save the key. Use a short name (letters, digits, - _ .) and a valid key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        aria-label="Account name"
        placeholder="Account name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-40"
      />
      <Input
        aria-label="API key"
        placeholder="API key"
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        className="w-64"
      />
      <Button type="submit" size="sm" disabled={busy || !name.trim() || apiKey.trim().length < 8}>
        Add key
      </Button>
      {error ? <p className="w-full text-xs text-destructive-foreground">{error}</p> : null}
    </form>
  );
}

function ProviderCard({ provider, onChanged }: { provider: ProviderInfo; onChanged: () => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-center gap-3">
        <ProviderIcon driver={provider.id} label={provider.label} className="size-6" />
        <h2 className="text-sm font-medium">{provider.label}</h2>
        <span className="ms-auto text-xs text-muted-foreground">
          {provider.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      {provider.auth === "localLogin" ? (
        <p className="text-xs text-muted-foreground">
          {provider.connected
            ? "Using the login already on this computer. Nothing to enter."
            : "Sign in with the provider's command line tool on this computer, then refresh."}
        </p>
      ) : (
        <>
          {provider.accounts.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {provider.accounts.map((account) => (
                <li key={account.id} className="flex items-center gap-3 text-sm">
                  <span className="truncate">{account.label}</span>
                  <span className="text-xs text-muted-foreground">key saved, hidden</span>
                  <Button
                    size="xs"
                    variant="outline"
                    className="ms-auto"
                    onClick={() => void api.removeKey(provider.id, account.id).then(onChanged)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <KeyForm provider={provider} onSaved={onChanged} />
        </>
      )}
    </section>
  );
}

export function ProvidersPage({ providers }: { providers: Loaded<readonly ProviderInfo[]> }) {
  const list = providers.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Keys stay on this computer, are stored encrypted, and are never shown again after saving.
      </p>
      {list.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} onChanged={providers.reload} />
      ))}
    </div>
  );
}
