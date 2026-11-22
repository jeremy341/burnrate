import { boot } from "./lib.mjs";
const h = await boot({ port: 13975 });
const typeInto = async (selector, text) => { await h.ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select&&e.select();return true})()`); await h.cdp.send("Input.insertText", { text }); await h.sleep(250); };
try {
  await h.goto("#settings/appearance");
  console.log(JSON.stringify((await h.api("/api/settings")).json.appearance));
  await h.clickText("New theme"); await h.sleep(500);
  await typeInto('input[placeholder="e.g. Aurora"]', "Alpha");
  await typeInto('input[aria-label="Background hex value"]', "#101820");
  await h.clickText("Create theme"); await h.sleep(800);
  console.log(JSON.stringify((await h.api("/api/settings")).json.appearance).slice(0,700));
  console.log(await h.ev(`localStorage.getItem('burnrate.boot')`));
  await h.clickText("Remove Alpha"); await h.sleep(500);
  await h.clickText("Remove theme"); await h.sleep(1200);
  console.log(JSON.stringify((await h.api("/api/settings")).json.appearance).slice(0,500));
  console.log(await h.ev(`localStorage.getItem('burnrate.boot')`), await h.ev(`document.documentElement.className+' '+document.documentElement.dataset.themeId`));
  console.log(h.consoleErrors, h.exceptions, h.logs.slice(-5));
} finally { await h.close(); }
