# Credits and sources

## Fan project disclaimer

Dark Cells Widgets is an unofficial, non-commercial fan project. It is not affiliated with, endorsed or sponsored by Games Workshop.

- **Games Workshop:** Warhammer 40,000, Adeptus Mechanicus, Judiciar, Tempormortis, cogitator, data-slate, auto-quill, purity seal and related names, symbols and imagery are trademarks or ™/® of Games Workshop Limited, used here without permission for fan purposes. No challenge to their status is intended.
- **Other games:** *Warhammer 40,000: Space Marine 2* (Saber Interactive / Focus Entertainment) and *Warhammer 40,000: Rogue Trader* (Owlcat Games) are named only as design references. No art, audio or other assets from any game are included in this repository or the app.

The project's own code is licensed under GPL-3.0 (see [LICENSE](LICENSE)). The fonts below keep their own licence.

## What ships with the app

### Fonts
Bundled through [Fontsource](https://fontsource.org/) npm packages. All four are licensed under the **SIL Open Font License 1.1**; full licence texts are in [`licenses/fonts/`](licenses/fonts/).

| Font | Used for | Copyright | Source |
|---|---|---|---|
| Cormorant SC | Labels, nameplates, buttons | © 2015 The Cormorant Project Authors (Christian Thalmann, Catharsis Fonts) | [github.com/CatharsisFonts/Cormorant](https://github.com/CatharsisFonts/Cormorant) · [Fontsource](https://fontsource.org/fonts/cormorant-sc) |
| EB Garamond | Body text | © 2017 The EB Garamond Project Authors (Georg Duffner, Octavio Pardo) | [github.com/octaviopardo/EBGaramond12](https://github.com/octaviopardo/EBGaramond12) · [Fontsource](https://fontsource.org/fonts/eb-garamond) |
| VT323 | Cogitator screen readouts | © 2011 The VT323 Project Authors (Peter Hull) | [Google Fonts](https://fonts.google.com/specimen/VT323) · [Fontsource](https://fontsource.org/fonts/vt323) |
| UnifrakturCook | Blackletter accent | © 2010 j. 'mach' wust, © 2009 Peter Wiegel. Reserved Font Name "UnifrakturCook" | [Fontsource](https://fontsource.org/fonts/unifrakturcook) |

### Images, icons and sound
Everything visual in the app was drawn for this project as SVG or CSS. Nothing is traced from or copied out of official artwork.

| Asset | Where | Notes |
|---|---|---|
| App icon (cogitator monitor with a cog-skull) | `src-tauri/icons/source/app-icon.svg` | Original drawing. The half-bone, half-machine cog-skull is a fan rendition of the Adeptus Mechanicus emblem (Games Workshop). The PNG, ICO and ICNS sizes in `src-tauri/icons/` are generated from the SVG with `tauri icon`. |
| Tempormortis hourglass, skulls, winged skull, cog, wax purity seal | `src/widgets/Tempormortis.tsx`, `src/components/Sigils.tsx` | Original SVG, based on the references below |
| Title bar and button icons (pin, minimise, close, vault, quill, hourglass) | `src/components/Icons.tsx` | Original SVG line icons |
| Data slate casing, cogitator screens, scanlines | `src/styles.css` | Pure CSS |
| Timer chime and toll | `src/widgets/Tempormortis.tsx` | Synthesised at runtime with the Web Audio API; no audio files |

## Design references (inspiration only, nothing copied or included)

**Concept**
- Tina Huang, *Learn 10X Faster In 10 Minutes*: the typewriter and avocado desktop widgets that logged to Obsidian. https://www.youtube.com/watch?v=sbmP6i-MChk

**Tempormortis**
- The Games Workshop Primaris Judiciar miniature, as pictured on Lexicanum: https://wh40k.lexicanum.com/wiki/Judicar
- An Ultramarines Judiciar figure by JoyToy, photographed by mad.figures (Instagram): https://www.instagram.com/p/DRC5bSCCMYk/
- Lore: Lexicanum, *Tempormortis*: https://wh40k.lexicanum.com/wiki/Tempormortis · Warhammer 40k Wiki, *Tempormortis*: https://warhammer40k.fandom.com/wiki/Tempormortis

**Auto Quill and data slate**
- Warhammer 40k Wiki, *Auto Quill*: https://warhammer40k.fandom.com/wiki/Auto_Quill (citing the *Dark Heresy* and *Only War* core rulebooks)
- Fantasy Flight Games forum archive, *What does an autoquill look like and how big is it?*: https://ffg-forum-archive.entropicdreams.com/topic/7076-what-does-an-autoquill-look-like-and-how-big-is-it
- Fantasy Flight Games forum archive, *Picturing the Auto Quill*: https://ffg-forum-archive.entropicdreams.com/topic/19126-picturing-the-auto-quill
- Dakka Dakka gallery, *Space Fleet Cobra Destroyer Dataslate*: https://www.dakkadakka.com/gallery/1030191-Space%20Fleet%20Cobra%20Destroyer%20Dataslate.html
- r/40krpg, a player-made data slate for a Rogue Trader campaign: https://www.reddit.com/r/40krpg/comments/gjfwzw/started_a_new_rt_campaign_recently_and_made_this/

**Cogitator look and app icon**
- Warhammer 40k Wiki, *Cogitator*: https://warhammer40k.fandom.com/wiki/Cogitator
- TheGamer, *Warhammer 40K: Space Marine 2 Proves That The Mechanicus Are The Most Interesting 40K Faction*: the green Mechanicus cogitator screens. https://www.thegamer.com/warhammer-40k-space-marine-2-mechanicus-most-interesting-faction/

**Overall UI language** (gunmetal frames, phosphor panels, small-caps labels, purity seals)
- *Warhammer 40,000: Rogue Trader* (Owlcat Games) screenshots, RPGFan gallery: https://www.rpgfan.com/gallery/warhammer-40000-rogue-trader-screenshots/

## Software dependencies
Installed from npm and crates.io, not stored in this repository. Each package keeps its own licence.

| Package | Licence |
|---|---|
| [Tauri](https://tauri.app/) (`tauri`, `@tauri-apps/api`, `@tauri-apps/cli`) | MIT or Apache-2.0 |
| `tauri-plugin-dialog`, `@tauri-apps/plugin-dialog` | MIT or Apache-2.0 |
| [React](https://react.dev/), `react-dom` | MIT |
| [Vite](https://vite.dev/), `@vitejs/plugin-react` | MIT |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 |
| `@fontsource/*` packages | OFL-1.1 (the fonts above) |
| [`serde`](https://serde.rs/), `serde_json` | MIT or Apache-2.0 |
| [`dotenvy`](https://github.com/allan2/dotenvy) | MIT |

If you hold rights to anything referenced here and want it credited differently or removed, please open an issue.
