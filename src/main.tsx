import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AppShell from "./app/AppShell";
import DataStylus from "./widgets/DataStylus";
import ChronoSiphon from "./widgets/ChronoSiphon";
import VaultGate from "./components/VaultGate";
import WidgetFrame from "./components/WidgetFrame";
import { CogitatorIcon, HourglassIcon, StylusIcon } from "./components/Icons";
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

// Every window loads this same page and picks what to show from its label:
// "main" is the full app; "data-stylus" and "chrono-siphon" are popped-out
// widgets (created by the backend's open_widget command).
// In a plain browser (`npm run dev`) use ?widget=data-stylus or
// ?widget=chrono-siphon to preview a widget; otherwise you get the main app.
function windowLabel(): string {
  if (isTauri()) return getCurrentWindow().label;
  return new URLSearchParams(location.search).get("widget") ?? "main";
}

const views: Record<string, { title: string; icon: React.ReactNode; render: () => React.ReactNode }> = {
  main: { title: "Cogitorium", icon: <CogitatorIcon size={14} />, render: () => <AppShell /> },
  "data-stylus": {
    title: "Data Stylus",
    icon: <StylusIcon size={14} />,
    render: () => (
      <WidgetFrame title="Data Stylus" icon={<StylusIcon size={14} />}>
        <DataStylus />
      </WidgetFrame>
    ),
  },
  "chrono-siphon": {
    title: "Chrono-Siphon",
    icon: <HourglassIcon size={14} />,
    render: () => (
      <WidgetFrame title="Chrono-Siphon" icon={<HourglassIcon size={14} />}>
        <ChronoSiphon />
      </WidgetFrame>
    ),
  },
};
const view = views[windowLabel()] ?? views.main;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <VaultGate title={view.title} icon={view.icon}>
      {view.render()}
    </VaultGate>
  </React.StrictMode>,
);
