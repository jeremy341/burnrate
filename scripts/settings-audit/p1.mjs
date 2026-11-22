import { boot } from "./lib.mjs";
const h = await boot({ port: 13971 });
try {
  for (const id of ["appearance"]) {
    await h.goto(`#settings/${id}`);
    const dump = await h.ev(`(()=>{const rows=[...document.querySelectorAll('[data-slot=settings-row] h3')].map(e=>e.textContent);return JSON.stringify(rows)})()`);
    console.log(id, dump);
  }
  console.log(h.consoleErrors, h.exceptions);
} finally { await h.close(); }
