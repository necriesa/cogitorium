import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, MaximiseIcon, MinimiseIcon, PinIcon, RestoreIcon, VaultIcon } from "./Icons";
import { chooseVault } from "../lib/vault";

type Props = { title: string; icon: ReactNode };

/**
 * Engraved nameplate title bar for the frameless windows.
 * `data-tauri-drag-region` lets you drag the window by it, and double-clicking
 * it maximises (capabilities: `allow-start-dragging`, `allow-internal-toggle-maximize`).
 * Resizable windows (the main app, the Data Stylus widget) also get a
 * maximise / restore button.
 */
export default function TitleBar({ title, icon }: Props) {
  const [pinned, setPinned] = useState(false);
  const [canMaximise, setCanMaximise] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const win = useMemo(() => (isTauri() ? getCurrentWindow() : null), []);

  // Show the button only on resizable windows, and keep its icon in step with
  // the window (it can also be maximised by double-clicking the title bar).
  useEffect(() => {
    if (!win) return;
    win.isResizable().then(setCanMaximise).catch(() => {});
    win.isMaximized().then(setMaximised).catch(() => {});
    const off = win.onResized(() => {
      win.isMaximized().then(setMaximised).catch(() => {});
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [win]);

  async function togglePin() {
    const next = !pinned;
    await win?.setAlwaysOnTop(next);
    setPinned(next);
  }

  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="nameplate" data-tauri-drag-region>
        <span className="nameplate-icon">{icon}</span>
        <span data-tauri-drag-region>{title}</span>
      </span>
      <span className="titlebar-buttons">
        {win && (
          <button className="stud" title="Change vault folder" aria-label="Change vault folder" onClick={() => chooseVault().catch(() => {})}>
            <VaultIcon size={14} />
          </button>
        )}
        <button
          className={pinned ? "stud active" : "stud"}
          title={pinned ? "Unpin" : "Keep on top"}
          aria-label={pinned ? "Unpin" : "Keep on top"}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          <PinIcon size={14} />
        </button>
        <button className="stud" title="Minimise" aria-label="Minimise" onClick={() => win?.minimize()}>
          <MinimiseIcon size={14} />
        </button>
        {canMaximise && (
          <button
            className="stud"
            title={maximised ? "Restore" : "Maximise"}
            aria-label={maximised ? "Restore" : "Maximise"}
            onClick={() => win?.toggleMaximize()}
          >
            {maximised ? <RestoreIcon size={14} /> : <MaximiseIcon size={14} />}
          </button>
        )}
        <button className="stud close" title="Close" aria-label="Close" onClick={() => win?.close()}>
          <CloseIcon size={14} />
        </button>
      </span>
    </header>
  );
}
