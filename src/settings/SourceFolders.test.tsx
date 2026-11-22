import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SourceFolderBlocks, SourceFolderEditor } from "./SourceFolders";
import { SOURCE_IDS } from "./sources";

const render = (props: Partial<Parameters<typeof SourceFolderEditor>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SourceFolderEditor, {
      label: "Mistral Vibe folders",
      placeholder: "Full path",
      paths: [],
      hideSensitive: false,
      onChange: () => undefined,
      ...props,
    }),
  );

const renderBlocks = (props: Partial<Parameters<typeof SourceFolderBlocks>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SourceFolderBlocks, {
      sources: {},
      status: () => undefined,
      hideSensitive: false,
      onChange: () => undefined,
      ...props,
    }),
  );

describe("SourceFolderEditor", () => {
  it("says only automatic discovery is used when nothing is added", () => {
    const html = render();
    expect(html).toContain("No extra folders. Only automatic discovery is used.");
    expect(html).not.toContain("<ul");
  });

  it("names the input and each remove button, and flags a folder the server cannot find in words", () => {
    const html = render({
      paths: ["D:\\profiles\\.vibe2", "E:\\gone"],
      status: [
        { path: "D:\\profiles\\.vibe2", found: true },
        { path: "e:\\gone\\", found: false },
      ],
    });
    expect(html).toContain('aria-label="Mistral Vibe folders"');
    expect(html).toContain('aria-label="Add a folder to Mistral Vibe folders"');
    expect(html).toContain('aria-label="Remove folder D:\\profiles\\.vibe2"');
    expect(html.match(/Folder not found on this computer/g)).toHaveLength(1);
    // The folder list scrolls internally, so it stays reachable by keyboard (WCAG 2.1.1).
    expect(html).toMatch(
      /aria-label="Mistral Vibe folders"[^>]*tabindex="0"|tabindex="0"[^>]*aria-label="Mistral Vibe folders"/,
    );
  });

  it("masks the user name in a home path while sensitive details are hidden", () => {
    const html = render({ paths: ["C:\\Users\\jane\\.vibe2"], hideSensitive: true });
    expect(html).not.toContain("jane");
    expect(html).toContain("C:\\Users\\[redacted]\\.vibe2");
  });

  it("keeps the Add button disabled until something is typed", () => {
    expect(render()).toMatch(/<button[^>]*disabled[^>]*>[^]*Add folder/);
  });
});

describe("SourceFolderBlocks", () => {
  it("renders one titled editor per source id, each with its own folders and status", () => {
    const html = renderBlocks({
      sources: { codex: ["D:\\profiles\\.codex"], vibe: ["D:\\profiles\\.vibe2"] },
      status: (id) => (id === "codex" ? [{ path: "D:\\profiles\\.codex", found: false }] : undefined),
    });
    // One editor per source id, titled from the presentation data ("Codex folders", ...).
    const editors = html.match(/Add a folder to [^"]* folders/g) ?? [];
    expect(editors).toHaveLength(SOURCE_IDS.length);
    expect(html).toContain("Claude Code folders");
    expect(html).toContain("Codex folders");
    expect(html).toContain("Goose folders");
    expect(html).toContain("Pi folders");
    // Each agent's folder list lands in its own editor; only the one the server cannot see is flagged.
    expect(html).toContain('aria-label="Remove folder D:\\profiles\\.codex"');
    expect(html).toContain('aria-label="Remove folder D:\\profiles\\.vibe2"');
    expect(html.match(/Folder not found on this computer/g)).toHaveLength(1);
    // An agent with no folders says so rather than hiding the block.
    expect(html).toContain("No extra folders. Only automatic discovery is used.");
  });
});
