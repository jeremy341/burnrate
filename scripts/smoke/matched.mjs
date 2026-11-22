import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, evaluate, findBrowser, findPageTarget, launchBrowser, waitFor } from "./cdp.mjs";
import { removeTmpRoot, resolveServerExe, resolveWebDir, startServer } from "./server.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let server, browser, cdp;
try {
  server = await startServer({ root: ROOT, exe: resolveServerExe({ root: ROOT }), webDir: resolveWebDir({ root: ROOT }), port: 13899 });
  browser = await launchBrowser({ exe: findBrowser(), profileDir: path.join(server.tmpRoot, "profile") });
  const page = await findPageTarget(browser.port);
  cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  await cdp.send("Page.navigate", { url: server.baseUrl + "/" });
  await waitFor(cdp, `!!document.querySelector('main[aria-label]')`, { label: "app" });
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-slot="toggle"]' });
  const m = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
  const matches = (m.matchedCSSRules || []).filter(r => r.rule.style.cssProperties.some(p => p.name === 'color'));
  console.log(JSON.stringify(matches.map(r => ({ selector: r.rule.selectorList.text, color: r.rule.style.cssProperties.find(p=>p.name==='color')?.value, layer: r.rule?.layer?.text })), null, 2));
} finally { if(cdp)cdp.close(); if(browser)await browser.close(); if(server)await server.stop(); removeTmpRoot(server?server.tmpRoot:null); }
