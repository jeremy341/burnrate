import { PlusIcon, TrashIcon } from "lucide-react";
import { useId, useState } from "react";

import { maskHomePath } from "~/api/diagnostics";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useGT } from "~/i18n";
import { SettingsBlock } from "~/settings/layout";
import {
  addSourcePath,
  describeSourceProblem,
  removeSourcePath,
  sameSourcePath,
  SOURCE_PRESENTATIONS,
  sourcePathsFor,
  type SourceId,
  type SourcePathProblem,
  type SourceStatus,
} from "./sources";

/**
 * Add and remove the folders one agent's files are read from. Saves on every change through `onChange`
 * (the whole new list: arrays replace on the server). The server checks the folder, so a list entry can
 * say "not found on this computer" next to it instead of silently reading nothing.
 */
export function SourceFolderEditor({
  label,
  placeholder,
  paths,
  status,
  hideSensitive,
  onChange,
}: {
  /** What the folders are, e.g. "Claude Code folders". Names the list and the input for assistive tech. */
  readonly label: string;
  readonly placeholder: string;
  readonly paths: readonly string[];
  /** What the server reported for these folders (absent on older servers or before the first save). */
  readonly status?: readonly SourceStatus[];
  readonly hideSensitive: boolean;
  readonly onChange: (paths: string[]) => void;
}) {
  const gt = useGT();
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<SourcePathProblem | null>(null);

  const add = () => {
    // An empty box on Enter is not an error worth shouting about; the Add button is disabled for it.
    if (!draft.trim()) return;
    const result = addSourcePath(paths, draft);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    setDraft("");
    onChange(result.paths);
  };

  return (
    <div className="grid min-w-0 gap-2">
      {paths.length > 0 ? (
        <ul
          aria-label={label}
          tabIndex={0}
          className="grid max-h-60 min-w-0 divide-y divide-border overflow-y-auto scroll-py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {paths.map((path) => {
            const missing = status?.find((entry) => sameSourcePath(entry.path, path))?.found === false;
            const shown = hideSensitive ? maskHomePath(path) : path;
            return (
              <li key={path} className="flex min-w-0 items-center gap-2 py-1.5">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={hideSensitive ? undefined : path}
                >
                  {shown}
                </code>
                {missing ? (
                  <span className="shrink-0 text-xs text-warning-foreground">
                    {gt("Folder not found on this computer")}
                  </span>
                ) : null}
                <Button
                  variant="ghost-destructive"
                  size="icon-xs"
                  aria-label={gt("Remove folder {path}", { path: shown })}
                  onClick={() => onChange(removeSourcePath(paths, path))}
                >
                  <TrashIcon aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{gt("No extra folders. Only automatic discovery is used.")}</p>
      )}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-1 basis-56">
          <Input
            id={inputId}
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label={gt("Add a folder to {label}", { label })}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              if (problem) setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          {problem ? (
            <span id={errorId} role="alert" className="text-xs text-destructive-foreground">
              {describeSourceProblem(problem, gt)}
            </span>
          ) : null}
        </div>
        <Button variant="outline" size="sm" disabled={!draft.trim()} onClick={add}>
          <PlusIcon aria-hidden />
          {gt("Add folder")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Every agent's block in Settings > Providers > Local sources: one `SettingsBlock` with an editor
 * per entry of `SOURCE_PRESENTATIONS`, titled and described from that data alone. Adding an agent to
 * `SOURCE_IDS` / `SOURCE_PRESENTATIONS` (and the server's `SOURCE_IDS`) is all it takes to grow the
 * section. `status` and `onChange` are the same callbacks the Settings screen already passes to a
 * single editor.
 */
export function SourceFolderBlocks({
  sources,
  status,
  hideSensitive,
  onChange,
  visibleIds,
}: {
  /** Only these agents get a block (default: all). Lets the page hide agents the user does not have. */
  readonly visibleIds?: readonly SourceId[];
  /** The `providers.sources` part of the settings (older servers and older files lack the new keys). */
  readonly sources: Readonly<Partial<Record<SourceId, readonly string[]>>>;
  /** What the server says about one agent's folders (absent on older servers or before the first save). */
  readonly status: (id: SourceId) => readonly SourceStatus[] | undefined;
  readonly hideSensitive: boolean;
  readonly onChange: (id: SourceId, paths: string[]) => void;
}) {
  const gt = useGT();
  return (
    <>
      {SOURCE_PRESENTATIONS.filter((entry) => !visibleIds || visibleIds.includes(entry.id)).map((entry) => (
        <SettingsBlock
          key={entry.id}
          id={`providers-sources-${entry.id}`}
          title={gt(entry.title)}
          description={gt(entry.helper)}
        >
          <SourceFolderEditor
            label={gt(entry.title)}
            placeholder={gt(entry.placeholder)}
            paths={sourcePathsFor(sources, entry.id)}
            status={status(entry.id)}
            hideSensitive={hideSensitive}
            onChange={(paths) => onChange(entry.id, paths)}
          />
        </SettingsBlock>
      ))}
    </>
  );
}
