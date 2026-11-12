import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AutoQuill from "./widgets/AutoQuill";
import Tempormortis from "./widgets/Tempormortis";
import VaultGate from "./components/VaultGate";
import { HourglassIcon, QuillIcon } from "./components/Icons";
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
// In a plain browser (`npm run dev`), use ?widget=tempormortis instead.
function widgetName(): string {
  if (isTauri()) return getCurrentWindow().label;
  return new URLSearchParams(location.search).get("widget") ?? "auto-quill";
}

const widgets: Record<string, { Widget: () => React.JSX.Element; title: string; icon: React.ReactNode }> = {
  "auto-quill": { Widget: AutoQuill, title: "Auto Quill", icon: <QuillIcon size={14} /> },
  tempormortis: { Widget: Tempormortis, title: "Tempormortis", icon: <HourglassIcon size={14} /> },
};
const { Widget, title, icon } = widgets[widgetName()] ?? widgets["auto-quill"];

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <VaultGate title={title} icon={icon}>
      <Widget />
    </VaultGate>
  </React.StrictMode>,
);
