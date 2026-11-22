import { boot } from "./lib.mjs";
const h = await boot({ port: 13924 });
try {
  await h.goto("#settings/general");
  console.log(await h.ev(`(()=>{const nav=document.querySelector('nav[aria-label="Settings sections"]');const cs=getComputedStyle(nav);const r=document.documentElement;return JSON.stringify({navBg:cs.backgroundColor,bodyBg:getComputedStyle(document.body).backgroundColor,cls:r.className,theme:r.dataset.themeId,sidebarVar:getComputedStyle(r).getPropertyValue('--sidebar'),bg:getComputedStyle(r).getPropertyValue('--background'),appSidebar:getComputedStyle(r).getPropertyValue('--app-theme-sidebar'),boot:localStorage.getItem('burnrate.boot'),mirror:(localStorage.getItem('burnrate.settings')||'').slice(0,300)})})()`));
  console.log(JSON.stringify((await h.api("/api/settings")).json.appearance).slice(0,300));
} finally { await h.close(); }
