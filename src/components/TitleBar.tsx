import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Props = { title: string; sigil: string };

/**
 * Custom title bar for the frameless widget windows.
 * `data-tauri-drag-region` lets you drag the window by this bar
 * (allowed by `core:window:allow-start-dragging` in capabilities/default.json).
 */
export default function TitleBar({ title, sigil }: Props) {
  const [pinned, setPinned] = useState(false);
  const win = isTauri() ? getCurrentWindow() : null;

  async function togglePin() {
    const next = !pinned;
    await win?.setAlwaysOnTop(next);
    setPinned(next);
  }

  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="titlebar-name" data-tauri-drag-region>
        <span className="sigil" aria-hidden="true">{sigil}</span> {title}
      </span>
      <span className="titlebar-buttons">
        <button
          className={pinned ? "tb-btn active" : "tb-btn"}
          title={pinned ? "Unpin (stop keeping on top)" : "Pin on top"}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          ⌖
        </button>
        <button className="tb-btn" title="Minimise" onClick={() => win?.minimize()}>
          –
        </button>
        <button className="tb-btn close" title="Close" onClick={() => win?.close()}>
          ✕
        </button>
      </span>
    </header>
  );
}
