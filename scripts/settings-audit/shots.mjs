// Screenshots of every settings section: dark+light x 1100x860 + 480x900. Usage: node shots.mjs <prefix> [realHome]
import { boot } from "./lib.mjs";
const prefix = process.argv[2] ?? "before";
const real = process.argv[3] === "real";
const SECTIONS = ["general", "appearance", "usage", "providers", "notifications", "shortcuts", "shell", "advanced", "data", "about"];
const h = await boot({ port: real ? 13923 : 13921, realHome: real });
try {
  for (const scheme of ["dark", "light"]) {
    await h.colorScheme(scheme);
    for (const [w, hh] of [[1100, 860], [480, 900]]) {
      await h.viewport(w, hh);
      for (const id of SECTIONS) {
        await h.goto(`#settings/${id}`);
        await h.sleep(500);
        await h.shot(`${prefix}-${id}-${scheme}-${w}`);
      }
    }
  }
  console.log("console errors:", h.consoleErrors, "exceptions:", h.exceptions);
} finally { await h.close(); }

