/**
 * A small axe-style audit for server-rendered markup. The repo has no DOM test environment, so the
 * checks run over the HTML string that `renderToStaticMarkup` returns. It is deliberately conservative:
 * it only reports what it can prove from the markup (a missing name, a dangling id reference, a
 * positive tabindex), never a guess about colour or layout.
 */

export interface A11yViolation {
  readonly rule: string;
  readonly element: string;
  readonly message: string;
}

interface Tag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly raw: string;
  readonly index: number;
  readonly end: number;
}

const TAG_PATTERN = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTR_PATTERN = /([^\s=>/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMED_ROLES = new Set([
  "button", "link", "checkbox", "switch", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "meter", "progressbar", "slider", "spinbutton", "textbox", "combobox", "img", "listbox", "dialog",
  "alertdialog", "tablist", "group", "radiogroup", "toolbar",
]);

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseTags(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    const attrs = new Map<string, string>();
    for (const attr of (match[2] ?? "").matchAll(ATTR_PATTERN)) {
      attrs.set(attr[1]!.toLowerCase(), decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
    }
    tags.push({
      name: match[1]!.toLowerCase(),
      attrs,
      raw: match[0],
      index: match.index!,
      end: match.index! + match[0].length,
    });
  }
  return tags;
}

/** The markup between a tag and its closing tag (no nesting of the same tag name is assumed for leaf controls). */
function innerHtml(html: string, tag: Tag): string {
  if (VOID_ELEMENTS.has(tag.name)) return "";
  const close = html.indexOf(`</${tag.name}>`, tag.end);
  return close === -1 ? "" : html.slice(tag.end, close);
}

/** Text a screen reader would read from inner markup: no aria-hidden subtrees, no scripts, `alt` and labels kept. */
export function accessibleText(inner: string): string {
  const withoutHidden = inner
    .replace(/<svg\b[^>]*aria-hidden[^>]*>[\s\S]*?<\/svg>/g, " ")
    .replace(/<(span|div|i|b|p)\b[^>]*aria-hidden="(?:true|)"[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<svg\b(?![^>]*aria-label)[^>]*>[\s\S]*?<\/svg>/g, " ");
  const named = withoutHidden.replace(/<[a-z][^>]*\s(?:aria-label|alt)="([^"]*)"[^>]*>/g, " $1 ");
  return decode(named.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function describe(tag: Tag): string {
  return tag.raw.length > 140 ? `${tag.raw.slice(0, 137)}...` : tag.raw;
}

export interface AuditOptions {
  /** The markup is a whole screen: require exactly one `main` and one level-one heading. */
  readonly page?: boolean;
}

export function auditMarkup(html: string, options: AuditOptions = {}): A11yViolation[] {
  const tags = parseTags(html);
  const violations: A11yViolation[] = [];
  const report = (rule: string, tag: Tag, message: string) =>
    violations.push({ rule, element: describe(tag), message });

  const ids = new Map<string, number>();
  for (const tag of tags) {
    const id = tag.attrs.get("id");
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const labelFor = new Set(
    tags.filter((tag) => tag.name === "label" && tag.attrs.has("for")).map((tag) => tag.attrs.get("for")!),
  );

  for (const [id, count] of ids) {
    if (count > 1) {
      const tag = tags.find((candidate) => candidate.attrs.get("id") === id)!;
      report("duplicate-id", tag, `id "${id}" is used ${count} times`);
    }
  }

  for (const tag of tags) {
    const role = tag.attrs.get("role");
    const hidden = tag.attrs.get("aria-hidden") === "true";
    const tabindex = tag.attrs.get("tabindex");

    if (tabindex !== undefined && Number(tabindex) > 0) {
      report("tabindex", tag, "A positive tabindex breaks the natural focus order");
    }
    for (const attr of ["aria-labelledby", "aria-describedby"]) {
      for (const ref of (tag.attrs.get(attr) ?? "").split(/\s+/).filter(Boolean)) {
        if (!ids.has(ref)) report("aria-ref", tag, `${attr} points at a missing id "${ref}"`);
      }
    }
    if (tag.name === "img" && !tag.attrs.has("alt")) report("image-alt", tag, "Images need alt text (or alt=\"\")");
    if (tag.name === "a" && tag.attrs.get("target") === "_blank" && !/noopener/.test(tag.attrs.get("rel") ?? "")) {
      report("link-rel", tag, "target=_blank links need rel=noopener");
    }
    if (hidden) continue;

    const isButton = tag.name === "button" && role === undefined;
    const isLink = tag.name === "a" && tag.attrs.has("href");
    const isField =
      (tag.name === "input" && !["hidden", "submit", "button", "reset"].includes(tag.attrs.get("type") ?? "text")) ||
      tag.name === "select" ||
      tag.name === "textarea";
    const needsName = isButton || isLink || isField || (role !== undefined && NAMED_ROLES.has(role) && role !== "group");
    if (needsName) {
      const labelledBy = tag.attrs.get("aria-labelledby");
      const name =
        tag.attrs.get("aria-label") ||
        (labelledBy ? "ref" : "") ||
        (isField && tag.attrs.get("id") && labelFor.has(tag.attrs.get("id")!) ? "label" : "") ||
        (isField ? tag.attrs.get("placeholder") ?? "" : "") ||
        tag.attrs.get("alt") ||
        accessibleText(innerHtml(html, tag)) ||
        tag.attrs.get("title") ||
        "";
      if (!name.trim()) report("accessible-name", tag, "Interactive element has no accessible name");
    }
    if (role === "meter" || role === "progressbar" || role === "slider") {
      if (!tag.attrs.has("aria-valuenow") && role !== "progressbar") {
        report("aria-value", tag, `role=${role} needs aria-valuenow`);
      }
      if (role === "meter" && !tag.attrs.has("aria-valuetext")) {
        report("aria-value", tag, "A meter should carry aria-valuetext so the figure is read with its context");
      }
    }
    if (tag.name === "table" && !/<(th|caption)\b/.test(innerHtml(html, tag))) {
      report("table-header", tag, "Data tables need header cells or a caption");
    }
  }

  // aria-hidden regions must not contain focusable controls (a screen reader user would tab into nothing).
  for (const tag of tags) {
    if (tag.attrs.get("aria-hidden") !== "true" || VOID_ELEMENTS.has(tag.name)) continue;
    const inner = innerHtml(html, tag);
    if (/<(button|a\s[^>]*href|input|select|textarea)\b|\stabindex="0"/.test(inner)) {
      report("aria-hidden-focus", tag, "aria-hidden content contains a focusable control");
    }
  }

  if (options.page) {
    const mains = tags.filter((tag) => tag.name === "main" || tag.attrs.get("role") === "main");
    if (mains.length !== 1) violations.push({ rule: "landmark-one-main", element: "<main>", message: `Expected one main landmark, found ${mains.length}` });
    const h1 = tags.filter((tag) => tag.name === "h1");
    if (h1.length !== 1) violations.push({ rule: "page-has-heading-one", element: "<h1>", message: `Expected one h1, found ${h1.length}` });
    const levels = tags.filter((tag) => /^h[1-6]$/.test(tag.name)).map((tag) => Number(tag.name[1]));
    levels.forEach((level, index) => {
      const previous = levels[index - 1];
      if (previous !== undefined && level > previous + 1) {
        violations.push({ rule: "heading-order", element: `<h${level}>`, message: `Heading jumps from h${previous} to h${level}` });
      }
    });
  }
  return violations;
}
