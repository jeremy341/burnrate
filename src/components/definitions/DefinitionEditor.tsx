import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  issueText,
  mappedAccount,
  parseDefinitionId,
  saveUserDefinition,
  testDefinition,
  validateDefinition,
  type TestDefinitionResult,
  type ValidateDefinitionResult,
} from "~/api/defs";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { T, useGT, Var } from "~/i18n";

/** A valid, minimal starting point following docs/CONTRACTS.md section 4. */
export const STARTER_DEFINITION = `# Change the id, label and hosts. Your key is only ever sent to key_hosts.
schema = 1
id = "my-provider"
label = "My Provider"
color = "#6467f2"
status = "experimental"
docs = "https://example.com/docs"
auth = "apiKey"
key_hosts = ["example.com"]
poll_seconds = 300

[[request]]
id = "key"
method = "GET"
url = "https://example.com/api/v1/key"
headers = { Authorization = "Bearer {{key}}" }
timeout_seconds = 10

[[window]]
id = "limit"
kind = "monthly"
label = "Limit"
from = "key"
used = "$.data.used"
limit = "$.data.limit"
provenance = "unofficial"
`;

export interface DefinitionEditorProps {
  /** Id of an existing user definition, when editing. Built-ins cannot be edited here. */
  readonly defId?: string;
  readonly initialToml?: string;
  /** Names of keys already stored for this definition id, offered as suggestions for "Test". */
  readonly keyNames?: readonly string[];
  readonly onChanged?: (id: string) => void;
  readonly onCancel?: () => void;
}

export function DefinitionEditor({
  defId,
  initialToml,
  keyNames = [],
  onChanged,
  onCancel,
}: DefinitionEditorProps) {
  const gt = useGT();
  const formId = useId();
  const tomlId = `${formId}-toml`;
  const keyId = `${formId}-key`;

  const [toml, setToml] = useState(initialToml ?? STARTER_DEFINITION);
  const [keyName, setKeyName] = useState("");
  const [validation, setValidation] = useState<ValidateDefinitionResult | null>(null);
  const [testResult, setTestResult] = useState<TestDefinitionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"validate" | "test" | "save" | null>(null);
  const [keyTouched, setKeyTouched] = useState(false);

  const account = testResult ? mappedAccount(testResult) : null;

  const validate = async (): Promise<ValidateDefinitionResult | null> => {
    setBusy("validate");
    setError(null);
    setSavedId(null);
    try {
      const result = await validateDefinition(toml);
      setValidation(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not validate the definition."));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!keyName.trim()) {
      setKeyTouched(true);
      return;
    }
    setBusy("test");
    setError(null);
    setSavedId(null);
    setTestResult(null);
    try {
      // Validate first: a broken definition must never cause a network request.
      const check = validation ?? (await validateDefinition(toml));
      setValidation(check);
      if (!check.ok) {
        setError(gt("Fix the validation errors before testing."));
        return;
      }
      const result = await testDefinition({ toml, keyName: keyName.trim() });
      setTestResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not test the definition."));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const id = parseDefinitionId(toml);
    if (!id) {
      setError(gt("Add a top-level `id` (lowercase letters, digits and hyphens) before saving."));
      return;
    }
    setBusy("save");
    setError(null);
    setSavedId(null);
    try {
      await saveUserDefinition(id, toml);
      setSavedId(id);
      onChanged?.(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not save the definition."));
    } finally {
      setBusy(null);
    }
  };

  const keyError = keyTouched && !keyName.trim() ? gt("Enter the name of a saved key.") : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={tomlId}>
          <T>Provider definition (TOML)</T>
        </Label>
        <Textarea
          id={tomlId}
          className="min-h-64 font-mono text-xs"
          spellCheck={false}
          value={toml}
          onChange={(event) => {
            setToml(event.target.value);
            setValidation(null);
            setTestResult(null);
            setSavedId(null);
          }}
          disabled={busy !== null}
          aria-describedby={`${tomlId}-help`}
        />
        <p id={`${tomlId}-help`} className="text-xs text-muted-foreground">
          <T>
            Validate only parses and lints the file; it never contacts the provider. Test runs the
            requests once with a stored key. Keys are only sent to the hosts in `key_hosts`.
          </T>
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={keyId}>
          <T>Key name for testing</T>
        </Label>
        <Input
          id={keyId}
          list={keyNames.length > 0 ? `${formId}-keys` : undefined}
          value={keyName}
          onChange={(event) => setKeyName(event.target.value)}
          onBlur={() => setKeyTouched(true)}
          placeholder={gt("e.g. Personal")}
          spellCheck={false}
          disabled={busy !== null}
          aria-invalid={keyError !== undefined}
          aria-describedby={keyError !== undefined ? `${keyId}-error` : `${keyId}-help`}
        />
        {keyNames.length > 0 ? (
          <datalist id={`${formId}-keys`}>
            {keyNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        ) : null}
        {keyError !== undefined ? (
          <p id={`${keyId}-error`} role="alert" className="text-xs text-destructive">
            {keyError}
          </p>
        ) : (
          <p id={`${keyId}-help`} className="text-xs text-muted-foreground">
            <T>
              Save a key for this provider id in the Providers view first. The test result is
              redacted; the key is never shown again.
            </T>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Button variant="outline" size="sm" onClick={() => void validate()} disabled={busy !== null}>
          {busy === "validate" ? <Spinner /> : null}
          <T>Validate</T>
        </Button>
        <Button variant="outline" size="sm" onClick={() => void test()} disabled={busy !== null}>
          {busy === "test" ? <Spinner /> : null}
          <T>Test definition</T>
        </Button>
        <Button type="submit" size="sm" disabled={busy !== null}>
          {busy === "save" ? <Spinner /> : null}
          {defId ? gt("Save changes") : gt("Save as user definition")}
        </Button>
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy !== null}>
            <T>Cancel</T>
          </Button>
        ) : null}
      </div>

      {validation ? (
        <div aria-live="polite" className="grid gap-2">
          {validation.ok ? (
            <Alert variant="success" role="status">
              <CircleCheckIcon />
              <AlertTitle>{gt("Definition is valid")}</AlertTitle>
              <AlertDescription>
                {validation.preview ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {validation.preview.label ?? validation.preview.id ? (
                      <Badge variant="secondary" size="sm">
                        {validation.preview.label ?? validation.preview.id}
                      </Badge>
                    ) : null}
                    {validation.preview.requests ? (
                      <Badge variant="outline" size="sm">
                        {gt("{count, plural, one {1 request} other {{count} requests}}", {
                          count: validation.preview.requests.length,
                        })}
                      </Badge>
                    ) : null}
                    {validation.preview.windows ? (
                      <Badge variant="outline" size="sm">
                        {gt("{count, plural, one {1 window} other {{count} windows}}", {
                          count: validation.preview.windows.length,
                        })}
                      </Badge>
                    ) : null}
                    {validation.preview.balances ? (
                      <Badge variant="outline" size="sm">
                        {gt("{count, plural, one {1 balance} other {{count} balances}}", {
                          count: validation.preview.balances.length,
                        })}
                      </Badge>
                    ) : null}
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="error" role="alert">
              <CircleAlertIcon />
              <AlertTitle>{gt("Definition has errors")}</AlertTitle>
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 ps-4">
                  {validation.errors.map((issue, index) => (
                    <li key={`${index}-${issueText(issue)}`}>{issueText(issue)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>
      ) : null}

      {testResult ? (
        <div aria-live="polite" className="grid gap-2">
          {account ? (
            <Alert variant="success" role="status">
              <CircleCheckIcon />
              <AlertTitle>{gt("Definition works")}</AlertTitle>
              <AlertDescription>
                <T>
                  Mapped account: <Var>{account.label}</Var>. Windows:{" "}
                  <Var>{account.limits.windows.length}</Var>. This result is redacted.
                </T>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="error" role="alert">
              <CircleAlertIcon />
              <AlertTitle>{gt("Definition test failed")}</AlertTitle>
              <AlertDescription>
                {testResult.error?.trim() || gt("The provider returned no usable limits.")}
              </AlertDescription>
            </Alert>
          )}
        </div>
      ) : null}

      {savedId ? (
        <Alert variant="success" role="status" aria-live="polite">
          <CircleCheckIcon />
          <AlertDescription>
            {gt("Saved user definition “{id}”.", { id: savedId })}
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" role="alert">
          <CircleAlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
