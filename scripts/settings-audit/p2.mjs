import { boot } from "./lib.mjs";
const h = await boot({ port: 13971 });
try {
  await h.goto(`#settings/appearance`);
  await h.clickText("New theme");
  await h.sleep(800);
  await h.shot("t-editor-new-dark-1100");
  const info = await h.ev(`(()=>{const d=document.querySelector('[role=dialog]');return JSON.stringify({dlg:!!d, text:(d?.innerText||document.body.innerText).slice(0,1500), btns:[...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>(b.getAttribute('aria-label')||b.innerText).trim()).slice(0,80)})})()`);
  console.log(info);
  console.log(h.consoleErrors, h.exceptions);
} finally { await h.close(); }
