import { boot } from "./lib.mjs";
const h = await boot({ port: 13925 });
try {
  await h.goto(`#settings/appearance`);
  console.log(await h.ev(`JSON.stringify([...document.querySelectorAll('button')].filter(e=>/mode|appearance/i.test(e.getAttribute('aria-label')||e.innerText)).map(e=>[e.getAttribute('aria-label'),e.innerText,e.offsetParent!==null,e.getAttribute('role')]))`));
} finally { await h.close(); }
