import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { onApp } from "./events";

export type WidgetLabel = "data-stylus" | "chrono-siphon";

/** Pops a section out of the main window as its own widget window (desktop only). */
export function openWidget(label: WidgetLabel): Promise<void> {
  return invoke("open_widget", { label });
}

/** Whether pop-outs are available (the desktop app), and which widgets are open. */
export function usePopOuts() {
  const [desktop, setDesktop] = useState(false);
  const [open, setOpen] = useState<string[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    invoke<boolean>("is_desktop").then(setDesktop).catch(() => setDesktop(false));
    invoke<string[]>("open_widgets").then(setOpen).catch(() => {});
    return onApp<string[]>("widgets-changed", setOpen);
  }, []);
  return { canPopOut: desktop, open };
}
