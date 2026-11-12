import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DataStylus from "./widgets/DataStylus";
import ChronoSiphon from "./widgets/ChronoSiphon";
import VaultGate from "./components/VaultGate";
import { HourglassIcon, StylusIcon } from "./components/Icons";
// Fonts are bundled (no network needed). Four roles, see styles.css:
// small-caps labels, readable body serif, cogitator readout, blackletter accent.
import "@fontsource/cormorant-sc/600.css";
import "@fontsource/cormorant-sc/700.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/600.css";
import "@fontsource/vt323/400.css";
import "@fontsource/unifrakturcook/700.css";
import "./styles.css";

// One frontend, two windows. Each window loads this same page, so we pick the
// widget from the window's label (set in src-tauri/tauri.conf.json).
// In a plain browser (`npm run dev`), use ?widget=chrono-siphon instead.
function widgetName(): string {
  if (isTauri()) return getCurrentWindow().label;
  return new URLSearchParams(location.search).get("widget") ?? "data-stylus";
}

const widgets: Record<string, { Widget: () => React.JSX.Element; title: string; icon: React.ReactNode }> = {
  "data-stylus": { Widget: DataStylus, title: "Data Stylus", icon: <StylusIcon size={14} /> },
  "chrono-siphon": { Widget: ChronoSiphon, title: "Chrono-Siphon", icon: <HourglassIcon size={14} /> },
};
const { Widget, title, icon } = widgets[widgetName()] ?? widgets["data-stylus"];

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <VaultGate title={title} icon={icon}>
      <Widget />
    </VaultGate>
  </React.StrictMode>,
);
