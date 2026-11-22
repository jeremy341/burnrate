// The settings sidebar is a full-height part of the app: it spans from the tab bar to the window bottom and
// the left edge, stays put while the content scrolls, and deep links still scroll the content pane.
import { boot } from "./lib.mjs";

const h = await boot({ port: 13927 });
const res = [];
const check = (name, ok, extra = "") => {
  res.push({ name, ok });
  console.log(`${ok ? "ok " : "BAD"} ${name} ${extra}`);
};
try {
  await h.viewport(1100, 860);
  await h.goto("#settings/appearance");
  const geo = await h.ev(`(()=>{const n=document.querySelector('nav[aria-label="Settings sections"]').getBoundingClientRect();const tab=document.querySelector('[data-slot=app-tabbar]').getBoundingClientRect();return {left:n.left,top:n.top,bottom:n.bottom,h:innerHeight,tabBottom:tab.bottom,w:n.width}})()`);
  check("sidebar touches the left edge", geo.left === 0, JSON.stringify(geo));
  check("sidebar starts right under the tab bar", Math.abs(geo.top - geo.tabBottom) < 1.5);
  check("sidebar reaches the window bottom", Math.abs(geo.bottom - geo.h) < 1.5);

  const before = await h.ev(`document.querySelector('nav[aria-label="Settings sections"]').getBoundingClientRect().top`);
  await h.ev(`document.querySelector('[data-settings-page-scroll] > div.overflow-y-auto').scrollTo({top:900})`);
  await h.sleep(200);
  const after = await h.ev(`({top:document.querySelector('nav[aria-label="Settings sections"]').getBoundingClientRect().top, scrolled:document.querySelector('[data-settings-page-scroll] > div.overflow-y-auto').scrollTop, pageScroll:document.scrollingElement.scrollTop})`);
  check("content scrolls, sidebar stays", after.scrolled > 0 && after.top === before && after.pageScroll === 0, JSON.stringify(after));

  await h.goto("#settings/usage-refresh-interval");
  await h.sleep(900);
  const row = await h.ev(`(()=>{const r=document.getElementById('usage-refresh-interval')?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,h:innerHeight}:null})()`);
  check("deep link scrolls its row into view", !!row && row.top >= 40 && row.bottom <= row.h, JSON.stringify(row));

  await h.viewport(480, 900);
  await h.goto("#settings/general");
  const m = await h.ev(`(()=>{const n=document.querySelector('nav[aria-label="Settings sections"]').getBoundingClientRect();return {left:n.left,w:n.width,vw:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  check("480px: full-width top bar, no horizontal overflow", m.left === 0 && Math.abs(m.w - m.vw) < 1.5 && !m.overflow, JSON.stringify(m));
  console.log("fails:", res.filter((r) => !r.ok).map((r) => r.name));
} finally {
  await h.close();
}
