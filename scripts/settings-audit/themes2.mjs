import fs from "node:fs";
import path from "node:path";
import { boot } from "./lib.mjs";
const h = await boot({ port: 13974 });
const check = (name, ok, extra = "") => console.log(ok ? "PASS" : "FAIL", name, extra);
const typeInto = async (selector, text) => {
  await h.ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select&&e.select();return true})()`);
  await h.cdp.send("Input.insertText", { text });
  await h.sleep(250);
};
const st = async () => (await h.api("/api/settings")).json?.appearance;
try {
  await h.goto("#settings/appearance");
  await h.clickText("New theme"); await h.sleep(500);
  await typeInto('input[placeholder="e.g. Aurora"]', "Alpha");
  await typeInto('input[aria-label="Background hex value"]', "#101820");
  await h.clickText("Create theme"); await h.sleep(800);
  let a = await st();
  check("created", !!a.customThemes?.alpha, JSON.stringify(Object.keys(a.customThemes||{})));
  console.log("theme prefs:", a.theme, JSON.stringify(a.themeHalves));
  // Edit/rename
  await h.clickText("Edit Alpha"); await h.sleep(600);
  await typeInto('[data-theme-editor-panel] input[placeholder]', "Beta");
  await h.clickText("Save changes"); await h.sleep(800);
  a = await st();
  console.log("after rename keys:", Object.keys(a.customThemes||{}), Object.values(a.customThemes||{}).map(t=>t.label||t.name));
  check("rename shown in library", await h.ev(`document.body.innerText.includes('Beta')`));
  // second mode for merge: add light palette
  await h.clickText("Edit Beta"); await h.sleep(600);
  await h.shot("t-editor-edit-dark-1100");
  await h.ev(`[...document.querySelectorAll('[data-theme-editor-panel] [role=group] button,[data-theme-editor-panel] button')].find(b=>b.innerText.trim()==='Light')?.click()`);
  await h.sleep(500);
  await h.shot("t-editor-light-half-dark-1100");
  console.log((await h.ev(`document.querySelector('[data-theme-editor-panel]').innerText`)).replace(/\n+/g," | "));
  await h.key("Escape"); await h.sleep(400);
  // Remove
  await h.clickText("Remove Beta"); await h.sleep(600);
  await h.shot("t-remove-confirm-dark-1100");
  console.log("dialog:", (await h.ev(`document.querySelector('[role=alertdialog],[role=dialog]:not([data-theme-editor-panel])')?.innerText`))?.replace(/\n+/g," | "));
  const btns = await h.ev(`[...document.querySelectorAll('[role=alertdialog] button,[role=dialog] button')].map(b=>b.innerText.trim()).filter(Boolean)`);
  console.log(btns);
  const del = btns.find(t=>/remove|delete/i.test(t));
  if (del) { await h.clickText(del); await h.sleep(700); }
  a = await st();
  check("removed", !Object.keys(a.customThemes||{}).length, JSON.stringify(a.customThemes ? Object.keys(a.customThemes):[]));
  console.log("theme after delete:", a.theme, JSON.stringify(a.themeHalves), "page bg", await h.ev(`getComputedStyle(document.body).backgroundColor`));
  console.log(h.consoleErrors, h.exceptions);
} catch (e) { console.log("ERROR", e.message); await h.shot("t-error2"); }
finally { await h.close(); }
