// Flip every switch in every section, check the server changed, reload and check the UI agrees.
import { boot } from "./lib.mjs";
const SECTIONS = ["general", "appearance", "usage", "providers", "notifications", "shortcuts", "shell", "advanced"];
const real = process.argv[2] === "real";
const h = await boot({ port: 13922, realHome: real });
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o ?? {})) { if (v && typeof v === "object" && !Array.isArray(v)) flat(v, p + k + ".", out); else out[p + k] = JSON.stringify(v); } return out; };
const diff = (a, b) => { const fa = flat(a), fb = flat(b); return Object.keys({ ...fa, ...fb }).filter((k) => fa[k] !== fb[k]).map((k) => `${k}: ${fa[k]} -> ${fb[k]}`); };
const switchesJs = `[...document.querySelectorAll('[role=switch]')].filter(e=>e.offsetParent!==null).map((e,i)=>({i,label:(e.getAttribute('aria-label')||e.closest('[data-setting-row],[id]')?.innerText||'').split(String.fromCharCode(10))[0].slice(0,60),on:e.getAttribute('aria-checked')==='true',dis:e.hasAttribute('disabled')||e.getAttribute('aria-disabled')==='true'}))`;
try {
  for (const id of SECTIONS) {
    await h.goto(`#settings/${id}`);
    const sw = await h.ev(switchesJs);
    console.log(`\n== ${id}: ${sw.length} switches`);
    for (const s of sw) {
      await h.goto(`#settings/${id}`);
      const list = await h.ev(switchesJs);
      const cur = list[s.i];
      if (!cur) continue;
      if (cur.dis) { console.log(`  [disabled] ${cur.label}`); continue; }
      const before = (await h.api("/api/settings")).json;
      await h.ev(`document.querySelectorAll('[role=switch]')[${(await h.ev(`[...document.querySelectorAll('[role=switch]')].indexOf([...document.querySelectorAll('[role=switch]')].filter(e=>e.offsetParent!==null)[${s.i}])`))}].click()`);
      await h.sleep(900);
      const after = (await h.api("/api/settings")).json;
      const d = diff(before, after);
      const uiNow = (await h.ev(switchesJs))[s.i]?.on;
      await h.reload();
      const uiReload = (await h.ev(switchesJs))[s.i];
      const ok = d.length > 0 && uiNow !== cur.on && uiReload?.on === uiNow;
      console.log(`  ${ok ? "ok " : "BAD"} ${cur.label} | ${cur.on}->${uiNow} reload:${uiReload?.on} | server: ${d.join("; ") || "NO CHANGE"}`);
      // flip back
    }
  }
  console.log("console errors:", h.consoleErrors.slice(0, 5), h.exceptions);
} finally { await h.close(); }

