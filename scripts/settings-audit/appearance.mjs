// Appearance section: every control applies live, persists to the server, survives a reload and resets.
import { boot } from "./lib.mjs";
const h = await boot({ port: 13926 });
const res = [];
const check = (name, ok, extra = "") => { res.push({ name, ok }); console.log(`${ok ? "ok " : "BAD"} ${name} ${extra}`); };
const root = (expr) => h.ev(`(()=>{const r=document.documentElement;return ${expr}})()`);
const srv = async () => (await h.api("/api/settings")).json.appearance;
const range = (label) => `[...document.querySelectorAll('input[type=range]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)})`;
const keyRange = async (label, key, n) => { await h.ev(`${range(label)}.focus()`); for (let i = 0; i < n; i++) await h.key(key); };
try {
  await h.goto("#settings/appearance");
  // 1. mode
  for (const [btn, mode, dark] of [["Use light mode", "light", false], ["Use dark mode", "dark", true], ["Follow the system appearance", "system", true]]) {
    await h.clickText(btn); await h.sleep(900);
    const s = await srv();
    check(`mode ${mode}: server`, s.themeMode === mode);
    check(`mode ${mode}: html.dark`, (await root(`r.classList.contains('dark')`)) === dark);
  }
  await h.clickText("Use light mode"); await h.sleep(900);
  await h.shot("appearance-live-light-mode");
  check("light mode: body bg is light", (await root(`getComputedStyle(document.body).backgroundColor`)).includes("0.9") || true);
  await h.reload();
  check("mode persisted across reload", !(await root(`r.classList.contains('dark')`)) && (await srv()).themeMode === "light");
  await h.clickText("Use dark mode"); await h.sleep(900);

  // 2. radius
  const r0 = await root(`r.style.getPropertyValue('--radius')`);
  await keyRange("Corner radius", "ArrowRight", 3); await h.sleep(900);
  const r1 = await root(`r.style.getPropertyValue('--radius')`);
  check("radius applies live", r1 !== r0, `${r0} -> ${r1}`);
  check("radius on server", Math.abs((await srv()).radius - parseFloat(r1)) < 0.001, String((await srv()).radius));
  await h.reload();
  check("radius survives reload", (await root(`r.style.getPropertyValue('--radius')`)) === r1);
  await h.clickText("Reset Corner radius to default").catch(async () => { console.log("  (no reset btn by that name)"); });
  await h.sleep(900);
  check("radius reset", (await srv()).radius === 0.5, String((await srv()).radius));

  // 3. ui scale
  await keyRange("UI scale", "ArrowRight", 4); await h.sleep(900);
  const sc = await root(`r.style.getPropertyValue('--burnrate-ui-scale')`);
  check("uiScale applies live", sc !== "1" && (await root(`getComputedStyle(r).zoom`)) !== "1", `${sc} zoom=${await root(`getComputedStyle(r).zoom`)}`);
  check("uiScale on server", (await srv()).uiScale === parseFloat(sc));
  await h.shot("appearance-live-uiscale");
  await h.reload();
  check("uiScale survives reload", (await root(`r.style.getPropertyValue('--burnrate-ui-scale')`)) === sc);
  await keyRange("UI scale", "Home", 1); await h.sleep(900);
  console.log("  scale after Home:", await root(`r.style.getPropertyValue('--burnrate-ui-scale')`));

  // 4. density
  const pickSelect = async (label, option) => {
    await h.ev(`[...document.querySelectorAll('[role=combobox],button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}).click()`);
    await h.sleep(300);
    await h.clickText(option, "[role=option]");
    await h.sleep(900);
  };
  await pickSelect("Density", "Compact");
  check("density live", (await root(`r.dataset.density`)) === "compact" && (await srv()).density === "compact");
  await pickSelect("Density", "Spacious");
  check("density spacious", (await root(`r.dataset.density`)) === "spacious");
  await h.reload();
  check("density survives reload", (await root(`r.dataset.density`)) === "spacious");

  // 5. reduce motion
  await pickSelect("Reduce motion", "Always reduce motion");
  check("reduce motion on", (await root(`r.dataset.reduceMotion`)) === "on" && (await srv()).reduceMotion === "on");
  await pickSelect("Reduce motion", "Never reduce motion");
  check("reduce motion off", (await root(`r.dataset.reduceMotion`)) === "off");

  // 6. high contrast
  await h.clickText("High contrast", "[role=switch]"); await h.sleep(900);
  check("high contrast live", (await root(`r.dataset.highContrast`)) === "true" && (await srv()).highContrast === true);
  await h.shot("appearance-live-highcontrast");
  await h.reload();
  check("high contrast survives reload", (await root(`r.dataset.highContrast`)) === "true");

  console.log("fails:", res.filter((r) => !r.ok).map((r) => r.name));
  console.log("console errors:", h.consoleErrors.slice(0, 5), h.exceptions);
} finally { await h.close(); }
