// Tiny dependency-free YAML subset parser used to validate Burnrate packaging files.
//
// Supported: block mappings and sequences, compact mappings inside sequences
// (`- name: x`), plain/quoted scalars, single-line flow sequences/maps, block
// scalars (`|`, `>`, `|-`, `>-`, `|+`, `>+`, optional indentation indicator),
// comments, a leading `---`, and blank lines anywhere.
//
// Not supported (rejected or treated as plain text): anchors, aliases, tags,
// multiple documents, multi-line flow collections, explicit keys (`? `).
// Everything is returned as strings so YAML 1.1 surprises (`on`, `yes`, `1.0`)
// never change key names or values. That is exactly what we want for linting
// workflow and manifest files.

export class YamlError extends Error {
  constructor(file, line, reason) {
    super(`${file}:${line}: ${reason}`);
    this.name = "YamlError";
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

const fail = (file, line, reason) => {
  throw new YamlError(file, line, reason);
};

const isSeqItem = (text) => text === "-" || text.startsWith("- ");

const skipBlank = (entries, i) => {
  while (i < entries.length && entries[i].blank) i++;
  return i;
};

const isBlockScalarHeader = (text) => /^[|>][+-]?\d?$/.test(text);

export function parseYaml(source, file = "<yaml>") {
  const raw = String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    if (line.includes("\t")) {
      fail(file, n + 1, "tab character found (YAML forbids tabs for indentation)");
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") {
      entries.push({ blank: true, indent: 0, text: "", line: n + 1 });
      continue;
    }
    const indent = line.length - line.trimStart().length;
    entries.push({ blank: false, indent, text: line.slice(indent).trimEnd(), line: n + 1 });
  }

  const start = skipBlank(entries, 0);
  if (start >= entries.length) return null;
  const [value, next] = parseNode(entries, start, entries[start].indent, file);
  const after = skipBlank(entries, next);
  if (after < entries.length) {
    fail(file, entries[after].line, `unexpected content at indentation ${entries[after].indent}`);
  }
  return value;
}

function parseNode(entries, i, indent, file) {
  i = skipBlank(entries, i);
  const entry = entries[i];
  if (!entry) return [null, i];
  if (entry.indent !== indent) {
    fail(file, entry.line, `expected indentation ${indent}, found ${entry.indent}`);
  }
  return isSeqItem(entry.text)
    ? parseSequence(entries, i, indent, file)
    : parseMapping(entries, i, indent, file);
}

function parseMapping(entries, i, indent, file, seed = null) {
  const map = Object.create(null);
  const add = (key, value, line) => {
    if (!key) fail(file, line, "empty mapping key");
    if (Object.prototype.hasOwnProperty.call(map, key)) fail(file, line, `duplicate key "${key}"`);
    map[key] = value;
  };

  if (seed) add(seed.key, seed.value, seed.line);
  i = skipBlank(entries, i);

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.indent < indent) break;
    if (entry.indent > indent) {
      fail(file, entry.line, `unexpected indentation ${entry.indent} (expected ${indent})`);
    }
    if (isSeqItem(entry.text)) {
      fail(file, entry.line, "sequence item where a mapping key was expected");
    }
    const pair = splitPair(entry.text);
    if (!pair) fail(file, entry.line, 'expected a "key: value" pair');
    const pairLine = entry.line;
    i = skipBlank(entries, i + 1);

    let value;
    let next = i;
    if (pair.rest === "") {
      if (next < entries.length && entries[next].indent > indent) {
        [value, next] = parseNode(entries, next, entries[next].indent, file);
      } else {
        value = null;
      }
    } else if (isBlockScalarHeader(pair.rest)) {
      [value, next] = parseBlockScalar(entries, next, indent, pair.rest, file);
    } else {
      value = parseScalarOrFlow(pair.rest, file, pairLine);
    }

    add(pair.key, value, pairLine);
    i = skipBlank(entries, next);
  }

  if (!seed && Object.keys(map).length === 0) {
    const line = entries[Math.min(i, entries.length - 1)]?.line ?? 1;
    fail(file, line, "empty mapping");
  }
  return [map, i];
}

function parseSequence(entries, i, indent, file) {
  const items = [];
  i = skipBlank(entries, i);

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.indent < indent) break;
    if (entry.indent > indent) {
      fail(file, entry.line, `unexpected indentation ${entry.indent} (expected ${indent})`);
    }
    if (!isSeqItem(entry.text)) break;

    const afterDash = entry.text.slice(1);
    const content = afterDash.trimStart();
    const contentIndent = indent + 1 + (afterDash.length - content.length);
    i = skipBlank(entries, i + 1);

    if (content === "") {
      if (i < entries.length && entries[i].indent > indent) {
        let nested;
        [nested, i] = parseNode(entries, i, entries[i].indent, file);
        items.push(nested);
      } else {
        items.push(null);
      }
      i = skipBlank(entries, i);
      continue;
    }

    const inlinePair = splitPair(content);
    if (!inlinePair) {
      items.push(parseScalarOrFlow(content, file, entry.line));
      if (i < entries.length && entries[i].indent > indent) {
        fail(file, entries[i].line, "unexpected indentation after a scalar sequence item");
      }
      continue;
    }

    // `- key: value` starts a mapping that continues on following lines at contentIndent.
    const item = Object.create(null);
    let value;
    let next = i;
    if (inlinePair.rest === "") {
      if (next < entries.length && entries[next].indent > contentIndent) {
        [value, next] = parseNode(entries, next, entries[next].indent, file);
      } else {
        value = null;
      }
    } else if (isBlockScalarHeader(inlinePair.rest)) {
      [value, next] = parseBlockScalar(entries, next, contentIndent, inlinePair.rest, file);
    } else {
      value = parseScalarOrFlow(inlinePair.rest, file, entry.line);
    }
    item[inlinePair.key] = value;

    i = skipBlank(entries, next);
    if (i < entries.length && entries[i].indent > indent) {
      if (isSeqItem(entries[i].text)) {
        fail(file, entries[i].line, "unexpected sequence inside a mapping sequence item");
      }
      const siblingIndent = entries[i].indent;
      let rest;
      [rest, i] = parseMapping(entries, i, siblingIndent, file);
      for (const key of Object.keys(rest)) {
        if (Object.prototype.hasOwnProperty.call(item, key)) {
          fail(file, entries[i - 1]?.line ?? entry.line, `duplicate key "${key}"`);
        }
        item[key] = rest[key];
      }
    }
    items.push(item);
    i = skipBlank(entries, i);
  }

  if (items.length === 0) {
    const line = entries[Math.min(i, entries.length - 1)]?.line ?? 1;
    fail(file, line, "empty sequence");
  }
  return [items, i];
}

function parseBlockScalar(entries, i, parentIndent, header, file) {
  const parts = [];
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.blank) {
      parts.push("");
      i++;
      continue;
    }
    if (entry.indent <= parentIndent) break;
    parts.push(entry.text);
    i++;
  }
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0) {
    fail(file, entries[Math.min(i, entries.length - 1)]?.line ?? 1, "empty block scalar");
  }
  const value = header.startsWith(">") ? parts.join(" ") : parts.join("\n");
  return [value, i];
}

function splitPair(text) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inSingle) {
      if (c === "'") {
        if (text[k + 1] === "'") {
          k++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === "]" || c === "}") {
      depth--;
      continue;
    }
    if (c === "#" && (k === 0 || /\s/.test(text[k - 1]))) break;
    if (c === ":" && depth === 0 && (k === text.length - 1 || /\s/.test(text[k + 1]))) {
      return { key: unquote(text.slice(0, k).trim()), rest: text.slice(k + 1).trim() };
    }
  }
  return null;
}

function stripComment(text) {
  let inSingle = false;
  let inDouble = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inSingle) {
      if (c === "'") {
        if (text[k + 1] === "'") {
          k++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "#" && k > 0 && /\s/.test(text[k - 1])) return text.slice(0, k).trimEnd();
  }
  return text;
}

const ESCAPES = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", "/": "/", "0": "\0" };

function unquote(text) {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\ntr/0])/g, (_, c) => ESCAPES[c] ?? c);
  }
  return text;
}

function parseScalarOrFlow(text, file, line) {
  const cleaned = stripComment(text).trim();
  if (cleaned === "") return null;
  if (cleaned.startsWith("[") || cleaned.startsWith("{")) {
    return parseFlow(cleaned, file, line);
  }
  if (cleaned.startsWith('"') || cleaned.startsWith("'")) {
    const quote = cleaned[0];
    const closing = quote === "'" ? cleaned.indexOf("'", 1) : findClosingDouble(cleaned);
    if (closing !== cleaned.length - 1) {
      fail(file, line, "unterminated or trailing content after a quoted scalar");
    }
  }
  return unquote(cleaned);
}

function findClosingDouble(text) {
  for (let k = 1; k < text.length; k++) {
    if (text[k] === "\\") {
      k++;
      continue;
    }
    if (text[k] === '"') return k;
  }
  return -1;
}

function parseFlow(text, file, line) {
  let k = 0;
  const failFlow = (reason) => fail(file, line, `flow collection: ${reason}`);

  const skipWs = () => {
    while (k < text.length && /\s/.test(text[k])) k++;
  };

  const readQuoted = () => {
    const start = k;
    const quote = text[k];
    k++;
    while (k < text.length) {
      if (quote === '"' && text[k] === "\\") {
        k += 2;
        continue;
      }
      if (text[k] === quote) {
        if (quote === "'" && text[k + 1] === "'") {
          k += 2;
          continue;
        }
        k++;
        return unquote(text.slice(start, k));
      }
      k++;
    }
    return failFlow("unterminated string");
  };

  const readPlain = (stopAtColon) => {
    const start = k;
    while (k < text.length) {
      const c = text[k];
      if (c === "," || c === "]" || c === "}" || (stopAtColon && c === ":")) break;
      k++;
    }
    const value = text.slice(start, k).trim();
    if (!value) failFlow("empty value");
    return value;
  };

  const readValue = () => {
    skipWs();
    if (text[k] === '"' || text[k] === "'") return readQuoted();
    if (text[k] === "[") return readSeq();
    if (text[k] === "{") return readMap();
    return readPlain(false);
  };

  const readSeq = () => {
    k++; // [
    const out = [];
    skipWs();
    if (text[k] === "]") {
      k++;
      return out;
    }
    for (;;) {
      out.push(readValue());
      skipWs();
      if (text[k] === ",") {
        k++;
        skipWs();
        if (text[k] === "]") {
          k++;
          return out;
        }
        continue;
      }
      if (text[k] === "]") {
        k++;
        return out;
      }
      return failFlow("expected , or ]");
    }
  };

  const readMap = () => {
    k++; // {
    const out = Object.create(null);
    skipWs();
    if (text[k] === "}") {
      k++;
      return out;
    }
    for (;;) {
      skipWs();
      const key = text[k] === '"' || text[k] === "'" ? readQuoted() : readPlain(true);
      skipWs();
      if (text[k] !== ":") return failFlow("expected : in mapping");
      k++;
      const value = readValue();
      if (Object.prototype.hasOwnProperty.call(out, key)) failFlow(`duplicate key "${key}"`);
      out[key] = value;
      skipWs();
      if (text[k] === ",") {
        k++;
        skipWs();
        if (text[k] === "}") {
          k++;
          return out;
        }
        continue;
      }
      if (text[k] === "}") {
        k++;
        return out;
      }
      return failFlow("expected , or }");
    }
  };

  const value = readValue();
  skipWs();
  if (k !== text.length) failFlow("trailing content");
  return value;
}

export function parseYamlFile(readFileSync, file) {
  return parseYaml(readFileSync(file, "utf8"), file);
}
