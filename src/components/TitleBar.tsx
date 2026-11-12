import { useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, MinimiseIcon, PinIcon, VaultIcon } from "./Icons";
import { chooseVault } from "../lib/vault";

type Props = { title: string; icon: ReactNode };

/**
 * Engraved nameplate title bar for the frameless widget windows.
 * `data-tauri-drag-region` lets you drag the window by it
 * (allowed by `core:window:allow-start-dragging` in capabilities/default.json).
 */
export default function TitleBar({ title, icon }: Props) {
  const [pinned, setPinned] = useState(false);
  const win = isTauri() ? getCurrentWindow() : null;

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
        <button className="stud close" title="Close" aria-label="Close" onClick={() => win?.close()}>
          <CloseIcon size={14} />
        </button>
      </span>
    </header>
  );
}
