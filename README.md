# Cogitorium

Gothic sci-fi desktop productivity widgets, themed on Warhammer 40,000, for tracking, managing and updating tasks. Every action is logged as Markdown in an Obsidian vault.

| Widget | What it does |
|---|---|
| **Data Stylus** ✎ | Paste a task. Prose is broken into subtasks (on sentences, semicolons, "then" and "after that"); bullet or checkbox lists are kept as they are, nesting included. Sealing writes a Markdown checklist to the vault. Ticks update that note, and ticks made in Obsidian come back when you focus the widget. |
| **Chrono-Siphon** ⧗ | A Pomodoro timer drawn as a gothic stasis hourglass: bronze frame, skull finial, winged-skull cap, crux pendant. Name the quarry, set the minutes, invoke stasis, and record the verdict when the sands run out. |
| **Cogitator** | A `/cogitator` Claude skill in the vault. It runs `scripts/cogitator_stats.py` for the numbers, then answers questions ("what was I doing two weeks ago?") or writes a weekly review. |

Inspired by the desktop widgets in Tina Huang's [Learn 10X Faster In 10 Minutes](https://www.youtube.com/watch?v=sbmP6i-MChk).

> Unofficial, non-commercial fan project. Not affiliated with or endorsed by Games Workshop. Warhammer 40,000 and related names and imagery are trademarks of Games Workshop Limited. Fonts, references and other sources are listed in [CREDITS.md](CREDITS.md).

## Design

The visual language follows Owlcat's *Warhammer 40,000: Rogue Trader* UI, and the tokens and rules are at the top of `src/styles.css`:

- **Cogitator screens:** green-phosphor panels (after the Mechanicus screens in *Space Marine 2*) for everything the widgets show. The Data Stylus is a handheld **data slate**: an iron casing with a grille, an activity lamp and a purity seal, a screen, and rune keys underneath. Everything else is a dark gunmetal frame.
- **Bronze** is used only for trims, rivets and the active state, never for large fills.
- **Four type roles:**
  - Cormorant SC for labels and buttons
  - EB Garamond for reading
  - VT323 for cogitator readouts
- **App icon:** a cogitator monitor showing the project's own emblem, a brain seen from above. The left half is flesh, with a bionic cable jacked into a riveted port. The right half has been replaced by archaic machinery: riveted armour plates, a cog, a vacuum valve, and a fold that turns into a ribbed conduit. There are deliberately no modern circuit-board traces, because the setting shuns thinking machines and runs on half-understood relic tech. The source is `src-tauri/icons/source/app-icon.svg`; regenerate the sizes with `npx tauri icon src-tauri/icons/source/app-icon.svg`, then touch `src-tauri/build.rs` so the next build re-embeds it.
- **Spacing** uses a 4px grid. Animations respect `prefers-reduced-motion`.
- **Original names and marks:** the project avoids Games Workshop's own terms and emblems in user-facing names. Name history:
  - Timer: *Tempormortis* (v0.1), then *Chronoglass* (v0.2), now *Chrono-Siphon* (v0.3).
  - Task widget: *Auto Quill* until v0.3, now *Data Stylus*.
  - Icon: the Mechanicus cog-skull was replaced in v0.2, the split brain/circuit emblem arrived in v0.3, and v0.4 made it flesh-and-machinery.
  - Project: *Dark Cells Widgets* until v0.4, now *Cogitorium*. The saved vault carries over.

  Logs written under the old names are still read. References are in [CREDITS.md](CREDITS.md).

## Stack

[Tauri 2](https://v2.tauri.app/) with a React 19 + TypeScript + Vite frontend. It is one app with two frameless windows (`data-stylus` and `chrono-siphon`). Both windows load the same page, and `src/main.tsx` picks the widget from the window's label.

## Setup (Windows)

1. Prerequisites ([Tauri docs](https://v2.tauri.app/start/prerequisites/)):
   - Microsoft C++ Build Tools with the **Desktop development with C++** workload (a Visual Studio 2022 install that includes it works).
   - WebView2, which is preinstalled on Windows 10 (1803+) and 11.
   - Rust through rustup, with the MSVC toolchain:
     ```
     winget install --id Rustlang.Rustup
     rustup default stable-msvc
     ```
   - Node.js LTS.
2. `npm install`
3. Optional, for development only: copy `.env.example` to `.env` and set `DARK_CELLS_VAULT`. Without it, the app asks for the vault folder on first run.

## Vault folder

On first run the app looks in Obsidian's own vault list (`%APPDATA%\obsidian\obsidian.json` on Windows) and uses the vault Obsidian has open, or your only vault. That choice is saved in `settings.json` in the app's config folder (`%APPDATA%\com.necriesa.cogitorium\`; a vault saved by pre-0.4 versions is carried over). The **Choose vault folder** screen appears only when it can't tell, for example when you have several vaults and none is open. You can change the vault any time with the folder button in the title bar, and both widgets switch together. Order of precedence: saved choice, then `DARK_CELLS_VAULT` (dev `.env`), then Obsidian's open vault.

## Run

| Command | What it does |
|---|---|
| `npm run tauri dev` | Runs the desktop app with hot reload. The first run compiles the Rust crates, which takes a few minutes. |
| `npm run dev` | Runs only the frontend in a browser at http://localhost:1420. Add `?widget=chrono-siphon` to switch widget. Logs go to the browser console instead of the vault. |
| `npm run tauri build` | Builds the release app (`src-tauri/target/release/cogitorium.exe`) and installers (`src-tauri/target/release/bundle/msi/` and `bundle/nsis/`). |
| `cd src-tauri && cargo test` | Runs the Rust unit tests. |

## What lands in the vault

Everything goes under `<vault>/Sources/Journal/Widgets/`. Set `DARK_CELLS_LOG_DIR` to use a different folder.

- **Daily log:** `<YYYY-MM-DD>.md`. Each action appends one line. The file is created with frontmatter the first time.
- **Scrolls:** `Scrolls/<Task>.md`. Each Data Stylus task is one checklist note (frontmatter has `progress: 2/5`). Tick it in the widget or in Obsidian; both stay in step.

```markdown
- 14:32 · Chrono-Siphon · 25 min · film demo
- 14:40 · Data Stylus · completed · Modern C++ chapter 1 · UE5 C++ refresh
```

## Cogitator stats

`scripts/cogitator_stats.py` (Python standard library only) counts what the widgets logged for a date range:
- focus minutes by day, task and hour, and streaks
- subtask completions
- every scroll's progress and idle days, with scrolls idle 7+ days marked as stalled

It finds the vault from the app's saved settings.

```
python scripts/cogitator_stats.py            # last 7 days, Markdown
python scripts/cogitator_stats.py --days 30 --json
python scripts/cogitator_stats.py --from 2026-11-01 --to 2026-11-30 --vault "D:/path/to/vault"
```

## Layout

```
src/                     React frontend (runs in the system webview)
  main.tsx               picks the widget from the window label
  widgets/               DataStylus.tsx, ChronoSiphon.tsx
  components/TitleBar    drag region, pin, minimise, close
  lib/vaultLog.ts        calls the Rust append_log command
  lib/scroll.ts          task breakdown, Markdown checklist in and out
  lib/scrollStore.ts     read/write/list scroll notes (Rust commands)
  components/Sigils.tsx  shared SVG skulls, cog, bronze and brass gradients
  styles.css             Dark Cells palette
src-tauri/               Rust backend
  src/lib.rs             append_log and scroll commands (file I/O, path checks)
  tauri.conf.json        app config and the two windows
  capabilities/          which window APIs the frontend may call
```

## Licence

Code: GPL-3.0, see [LICENSE](LICENSE). The bundled fonts are under the SIL Open Font License 1.1 (texts in [`licenses/fonts/`](licenses/fonts/)). The full list of sources, references and dependency licences is in [CREDITS.md](CREDITS.md).
