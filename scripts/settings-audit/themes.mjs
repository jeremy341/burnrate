// Theme editor audit: create, live preview not persisted, Esc/Cancel restore, contrast fix, duplicate, rename, delete.
import { boot } from "./lib.mjs";
const real = process.argv[2] === "real";
const h = await boot({ port: real ? 13973 : 13972, realHome: real });
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, extra]); console.log(ok ? "PASS" : "FAIL", name, extra); };
const typeInto = async (selector, text) => {
  await h.ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select&&e.select();return true})()`);
  await h.cdp.send("Input.insertText", { text });
  await h.sleep(250);
};
const rootBg = () => h.ev(`getComputedStyle(document.documentElement).getPropertyValue('--background').trim()+'|'+getComputedStyle(document.body).backgroundColor`);
const serverThemes = async () => Object.keys(((await h.api("/api/settings")).json?.appearance?.customThemes) ?? {});
try {
  await h.goto("#settings/appearance");
  const before = await rootBg();
  const themesBefore = await serverThemes();
  await h.clickText("New theme");
  await h.sleep(600);
  // live preview: change background
  await typeInto('input[aria-label="Background hex value"]', "#203040");
  await h.sleep(500);
  const during = await rootBg();
  check("live preview changes the app background", during !== before, `${before} -> ${during}`);
  const mid = await serverThemes();
  check("preview is not persisted before Save", mid.length === themesBefore.length);
  const mirrorMid = await h.ev(`(localStorage.getItem('burnrate.settings')||localStorage.getItem('burnrate.settings.mirror')||'').includes('203040')`);
  check("preview is not mirrored to localStorage", !mirrorMid);
  await h.shot("t-editor-preview-dark-1100");
  await h.key("Escape");
  await h.sleep(500);
  const afterEsc = await rootBg();
  check("Esc closes editor and restores colours", afterEsc === before && !(await h.ev(`!!document.querySelector('[data-theme-editor-panel]')`)), afterEsc);
  // reopen, Cancel button restore
  await h.clickText("New theme"); await h.sleep(500);
  await typeInto('input[aria-label="Background hex value"]', "#304020"); await h.sleep(400);
  await h.clickText("Cancel"); await h.sleep(500);
  check("Cancel restores colours", (await rootBg()) === before);
  // empty name disables create
  await h.clickText("New theme"); await h.sleep(500);
  const disabled = await h.ev(`[...document.querySelectorAll('[data-theme-editor-panel] button')].find(b=>b.innerText.trim()==='Create theme')?.disabled`);
  check("Create disabled with empty name", disabled === true);
  // bad hex
  await typeInto('input[aria-label="Accent hex value"]', "notacolor"); await h.sleep(300);
  const bad = await h.ev(`document.querySelector('input[aria-label="Accent hex value"]').getAttribute('aria-invalid')`);
  console.log("bad hex aria-invalid:", bad);
  await h.shot("t-editor-badhex-dark-1100");
  await typeInto('input[aria-label="Accent hex value"]', "#7c3aed"); await h.sleep(300);
  // contrast fail: text vs surface -> set background to mid grey in advanced? simple mode: background only
  await typeInto('input[aria-label="Background hex value"]', "#808080"); await h.sleep(400);
  const contrast = await h.ev(`document.querySelector('[data-theme-editor-panel]').innerText.match(/Text on surface[\s\S]{0,60}/)?.[0]`);
  console.log("contrast text:", JSON.stringify(contrast));
  await h.shot("t-editor-contrast-dark-1100");
  const fixBtn = await h.ev(`[...document.querySelectorAll('[data-theme-editor-panel] button')].map(b=>b.innerText.trim()).filter(t=>/fix/i.test(t))`);
  console.log("fix buttons:", fixBtn);
  if (fixBtn.length) { await h.clickText(fixBtn[0]); await h.sleep(400);
    const after = await h.ev(`document.querySelector('[data-theme-editor-panel]').innerText.match(/Text on surface[\s\S]{0,60}/)?.[0]`);
    check("contrast fix reaches threshold", /Passes/.test(after), JSON.stringify(after)); }
  await typeInto('input[aria-label="Background hex value"]', "#101820"); await h.sleep(300);
  await typeInto('input[placeholder="e.g. Aurora"]', "Audit theme"); await h.sleep(300);
  await h.clickText("Create theme"); await h.sleep(900);
  const themesAfter = await serverThemes();
  check("Create persists a theme on the server", themesAfter.length === themesBefore.length + 1, themesAfter.join(","));
  check("new theme is active (library lists it)", await h.ev(`document.body.innerText.includes('Audit theme')`));
  await h.reload();
  await h.goto("#settings/appearance");
  check("theme survives reload", await h.ev(`document.body.innerText.includes('Audit theme')`));
  await h.shot("t-library-after-create-dark-1100");
  // duplicate
  await h.clickText("Duplicate Audit theme"); await h.sleep(700);
  const dupName = await h.ev(`document.querySelector('[data-theme-editor-panel] input[placeholder]')?.value`);
  console.log("duplicate opens editor with name:", dupName);
  await h.shot("t-editor-duplicate-dark-1100");
  await h.key("Escape"); await h.sleep(300);
  // find edit/delete/rename affordance on a custom theme
  const aff = await h.ev(`[...document.querySelectorAll('button,[role=menuitem]')].filter(b=>b.offsetParent).map(b=>(b.getAttribute('aria-label')||b.innerText).trim()).filter(t=>/Audit theme/.test(t))`);
  console.log("affordances for custom theme:", aff);
  console.log(h.consoleErrors, h.exceptions);
} catch (e) { console.log("ERROR", e.message); await h.shot("t-error"); }
finally { await h.close(); }
