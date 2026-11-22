// Must stay first: applies the saved palette, mode and fonts before the app graph evaluates.
import "./appearanceBoot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./appearance.css";
import { useAppearanceSync } from "./appearance";
import { App } from "./App";
import { AppProviders } from "./AppProviders";
import "./a11y.css";

function AppearanceSync() {
  useAppearanceSync();
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <AppearanceSync />
      <App />
    </AppProviders>
  </StrictMode>,
);
