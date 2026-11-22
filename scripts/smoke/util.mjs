// Small dependency-free helpers shared by smoke.mjs and api.mjs.
// Node 24 only: global fetch/WebSocket/AbortSignal.timeout are used by the callers.

/** Converts `--open-data-dir` to `openDataDir`. */
export function camelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

/**
 * Parses `--name value`, `--name=value` and bare `--flag` options.
 * Unknown bare flags mean `true`; the caller decides what is valid.
 */
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}". Options look like --name value.`);
    }
    const equals = argument.indexOf("=");
    const rawName = (equals === -1 ? argument.slice(2) : argument.slice(2, equals)).trim();
    if (!rawName) throw new Error(`Empty option in "${argument}".`);
    const name = camelCase(rawName);
    if (equals !== -1) {
      options[name] = argument.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = next;
      index += 1;
    }
  }
  return options;
}

export function optionString(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (value === true) throw new Error(`--${name} needs a value.`);
  return String(value);
}

export function optionNumber(options, name, fallback) {
  const raw = options[name];
  if (raw === undefined) return fallback;
  if (raw === true) throw new Error(`--${name} needs a number.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${raw}".`);
  return value;
}

export function optionBoolean(options, name) {
  if (!(name in options)) return false;
  const value = options[name];
  if (value === true || value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`--${name} must be true or false.`);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** `YYYY-MM-DD` in UTC, which is the day format `/api/usage` accepts. */
export function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function isoNow() {
  return new Date().toISOString();
}

/** A safe file-name fragment for screenshots and reports. */
export function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "step";
}

/** Keeps the last `count` entries; used for server log tails. */
export function tail(list, count = 40) {
  return list.slice(-count);
}

export function dedupe(values) {
  return [...new Set(values)];
}

/**
 * Browser console noise that must not fail the smoke run. Everything else is an error.
 * Keep this list tiny and specific: a missing favicon is the only asset the server does not serve.
 */
const IGNORED_CONSOLE_ERRORS = [
  /favicon\.(?:ico|png|svg)(?:\b|$)/i,
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
];

export function isIgnoredConsoleError(text) {
  const message = String(text ?? "");
  return IGNORED_CONSOLE_ERRORS.some((pattern) => pattern.test(message));
}

/** One line per error, without stack frames from CDP objects. */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
