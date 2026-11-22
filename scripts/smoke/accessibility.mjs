// Browser accessibility audit for the smoke harness. No dependencies: the page-side checks are one
// self-contained expression (so it can be evaluated through `evaluate(cdp, ...)`), and the maths it
// relies on (WCAG contrast) is also exported here so it is unit tested without a browser.
//
//   import { auditAccessibility } from "./accessibility.mjs";
//   const findings = await auditAccessibility(cdp, { label: "usage-dark" });
//
// NOT verified in a browser by the author of this file: the page expression only runs where a built
// app and a Chromium are available (see README.md). The static markup audit in
// src/components/ui/a11yAudit.test.tsx is what runs in unit tests.

import { evaluate } from "./cdp.mjs";

/** sRGB channel (0-255) to linear light. */
function channel(value) {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `[r, g, b]` colour. */
export function relativeLuminance([red, green, blue]) {
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

/** WCAG contrast ratio of two `[r, g, b]` colours, 1 to 21. */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Alpha-composites `[r, g, b, a]` over an opaque `[r, g, b]`. */
export function composite([red, green, blue, alpha], [backRed, backGreen, backBlue]) {
  return [
    Math.round(red * alpha + backRed * (1 - alpha)),
    Math.round(green * alpha + backGreen * (1 - alpha)),
    Math.round(blue * alpha + backBlue * (1 - alpha)),
  ];
}

/** Thresholds shared with the page expression. */
export const THRESHOLDS = Object.freeze({
  text: 4.5,
  largeText: 3,
  uiComponent: 3,
  // Dividers are decorative (WCAG exempts them) but T3's are visible: below this a hairline vanishes.
  divider: 1.25,
  targetPx: 24,
});

/**
 * Page-side audit. Returns `{ findings, counts }`; every finding is
 * `{ rule, severity, selector, message }`. Written as a string so nothing from this module's scope
 * leaks into the page.
 */
export const A11Y_AUDIT_EXPRESSION = `(() => {
  const T = ${JSON.stringify(THRESHOLDS)};
  // Freeze transitions/animations before sampling: theme boot changes colours with a CSS
  // transition, and sampling mid-flight reports a stale colour that is not what the user sees.
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(freeze);
  const findings = [];
  const add = (rule, severity, el, message) => findings.push({ rule, severity, selector: describe(el), message });
  const describe = (el) => {
    if (!el || !el.tagName) return String(el);
    const id = el.id ? '#' + el.id : '';
    const label = el.getAttribute('aria-label');
    const cls = typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') : '';
    return el.tagName.toLowerCase() + id + cls + (label ? '[aria-label="' + label.slice(0, 40) + '"]' : '');
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // fillStyle normalises any CSS colour (oklch, color-mix, named) to sRGB bytes.
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lum = ([r, g, b]) => {
    const c = (v) => { const u = v / 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = ([r, g, b, a], [br, bg, bb]) => [Math.round(r * a + br * (1 - a)), Math.round(g * a + bg * (1 - a)), Math.round(b * a + bb * (1 - a))];
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] === 1) break;
    }
    let base = rgba(getComputedStyle(document.documentElement).backgroundColor);
    base = base[3] === 0 ? [255, 255, 255] : base.slice(0, 3);
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const visible = (el) => {
    if (el.closest('[inert],[hidden],[aria-hidden="true"],.sr-only')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const nameOf = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (text) return text;
    }
    return (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('alt') || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
  };

  // 1. Document basics.
  if (!document.documentElement.lang) add('html-lang', 'serious', document.documentElement, 'The page has no lang attribute');
  if (!document.title.trim()) add('document-title', 'serious', document.documentElement, 'The page has no title');
  const mains = [...document.querySelectorAll('main,[role="main"]')].filter(visible);
  if (mains.length !== 1) add('landmark-one-main', 'moderate', document.body, 'Expected one visible main landmark, found ' + mains.length);
  const h1 = [...document.querySelectorAll('h1')].filter((el) => !el.closest('[inert]'));
  if (h1.length !== 1) add('page-has-heading-one', 'moderate', document.body, 'Expected one h1 on the visible screen, found ' + h1.length);

  // 2. Names, keyboard reachability and target size of every visible control.
  const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=switch],[role=checkbox],[role=meter],[tabindex]')].filter(visible);
  for (const el of controls) {
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) > 0) add('tabindex', 'serious', el, 'Positive tabindex');
    const role = el.getAttribute('role');
    // A roving tabindex is correct inside a toggle group / menu; only one item is tabbable.
    if (tabindex === '-1' && !role && el.tagName !== 'DIV' && el.tagName !== 'MAIN' && !el.disabled && !el.closest('[data-slot="toggle-group"],[role="menu"],[role="menubar"]') && !el.matches('[data-app-content],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]')) {
      add('focusable', 'moderate', el, 'Interactive element is removed from the tab order');
    }
    if (!nameOf(el)) add('accessible-name', 'critical', el, 'Control has no accessible name');
    const box = el.getBoundingClientRect();
    const coarse = matchMedia('(pointer: coarse)').matches;
    const min = coarse ? 44 : T.targetPx;
    if (!el.matches('a[href]') && (box.width < min - 0.5 || box.height < min - 0.5) && !el.closest('[role=menu]')) {
      add('target-size', 'moderate', el, 'Target is ' + Math.round(box.width) + 'x' + Math.round(box.height) + 'px, minimum ' + min);
    }
    const style = getComputedStyle(el);
    if (style.pointerEvents === 'none' && !el.disabled) add('pointer-events', 'minor', el, 'Interactive element ignores the pointer');
  }

  // 3. Text contrast (sampled: the first 600 visible leaf text nodes).
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let checked = 0;
  const seen = new Set();
  while (walker.nextNode() && checked < 600) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent.trim() || !visible(el) || el.closest('.sr-only,script,style')) continue;
    seen.add(el);
    checked += 1;
    const style = getComputedStyle(el);
    const disabled = el.closest(':disabled,[aria-disabled="true"]');
    if (disabled) continue;
    const bg = backdrop(el);
    const fg = over(rgba(style.color), bg);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? T.largeText : T.text;
    const got = ratio(fg, bg);
    if (got < need) add('color-contrast', 'serious', el, 'Contrast ' + got.toFixed(2) + ':1 is below ' + need + ':1 (' + size.toFixed(0) + 'px, "' + node.textContent.trim().slice(0, 30) + '")');
  }

  // 4. Dividers must be visible (the dark-mode hairline regression): every drawn border against its backdrop.
  const lines = new Map();
  for (const el of document.querySelectorAll('header,section,aside,nav,main *,[class*="border"]')) {
    if (lines.size > 400 || !visible(el)) continue;
    const style = getComputedStyle(el);
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      if (parseFloat(style['border' + side + 'Width']) < 0.5 || style['border' + side + 'Style'] === 'none') continue;
      const color = rgba(style['border' + side + 'Color']);
      if (color[3] === 0) continue;
      const parent = el.parentElement || el;
      const bg = backdrop(parent);
      const got = ratio(over(color, bg), bg);
      const key = style['border' + side + 'Color'] + '|' + describe(parent);
      if (got < T.divider && !lines.has(key)) { lines.set(key, true); add('divider-contrast', 'moderate', el, 'border-' + side.toLowerCase() + ' is ' + got.toFixed(2) + ':1 against its background, below ' + T.divider + ':1 (invisible hairline)'); }
    }
  }

  // 5. Meters, progress and status dots expose a value or text, not only colour.
  for (const el of document.querySelectorAll('[role=meter],[role=progressbar]')) {
    if (!visible(el) && !el.matches('.sr-only')) continue;
    if (!el.hasAttribute('aria-valuenow') && el.getAttribute('role') === 'meter') add('aria-value', 'serious', el, 'meter has no aria-valuenow');
    if (!nameOf(el)) add('accessible-name', 'critical', el, 'meter has no name');
  }

  // 6. Live regions: more than a handful of assertive regions means announcements will fight.
  const assertive = document.querySelectorAll('[aria-live="assertive"],[role="alert"]').length;
  if (assertive > 3) add('live-region', 'minor', document.body, assertive + ' assertive live regions at once');

  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  return { findings, counts };
})()`;

/** Runs the page audit and returns `{ findings, counts }`. */
export async function auditAccessibility(cdp, { label = "page" } = {}) {
  const result = await evaluate(cdp, A11Y_AUDIT_EXPRESSION);
  return { label, findings: result.findings ?? [], counts: result.counts ?? {} };
}

/** Emulates `prefers-reduced-motion: reduce` and reports infinite animations still running. */
export async function auditReducedMotion(cdp) {
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    const running = await evaluate(
      cdp,
      `document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.playState === 'running').map((a) => a.effect?.target?.className?.toString?.().slice(0, 60) ?? 'unknown')`,
    );
    return { label: "reduced-motion", findings: running.map((target) => ({ rule: "reduced-motion", severity: "moderate", selector: target, message: "Infinite animation still runs under prefers-reduced-motion: reduce" })) };
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }
}

/** Findings that fail a run: critical and serious. The rest are reported, not fatal. */
export function blockingFindings(report) {
  return report.findings.filter((finding) => finding.severity === "critical" || finding.severity === "serious");
}
