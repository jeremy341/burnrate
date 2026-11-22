import { boot } from "./lib.mjs";
const id = process.argv[2] ?? "appearance";
const h = await boot({ port: 13925 });
try {
  await h.goto(`#settings/${id}`);
  const out = await h.ev(`[...document.querySelectorAll('main button, main input, main select, main [role], main a, main textarea, [data-settings-page-scroll] button, [data-settings-page-scroll] input, [data-settings-page-scroll] [role]')].filter(e=>e.offsetParent!==null).map(e=>[e.tagName.toLowerCase(),e.getAttribute('role')||e.type||'',(e.getAttribute('aria-label')||e.innerText||e.placeholder||'').trim().replace(/\s+/g,' ').slice(0,50), e.value&&e.type!=='checkbox'?String(e.value).slice(0,20):''].join('|')).filter((v,i,a)=>a.indexOf(v)===i)`);
  console.log(out.join("\n"));
} finally { await h.close(); }
