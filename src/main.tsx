import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AutoQuill from "./widgets/AutoQuill";
import Tempormortis from "./widgets/Tempormortis";
// Fonts are bundled (no network needed): blackletter titles, a period serif
// for the parchment, and an engraved capitals face for brass labels.
import "@fontsource/unifrakturcook/700.css";
import "@fontsource/im-fell-english/400.css";
import "@fontsource/im-fell-english/400-italic.css";
import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/700.css";
import "./styles.css";

// One frontend, two windows. Each window loads this same page, so we pick the
// widget from the window's label (set in src-tauri/tauri.conf.json).
// In a plain browser (`npm run dev`), use ?widget=tempormortis instead.
function widgetName(): string {
  if (isTauri()) return getCurrentWindow().label;
  return new URLSearchParams(location.search).get("widget") ?? "auto-quill";
}

const widgets: Record<string, () => React.JSX.Element> = {
  "auto-quill": AutoQuill,
  tempormortis: Tempormortis,
};
const Widget = widgets[widgetName()] ?? AutoQuill;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Widget />
  </React.StrictMode>,
);
