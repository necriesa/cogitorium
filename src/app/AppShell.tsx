import { useEffect, useState, type ReactNode } from "react";
import TitleBar from "../components/TitleBar";
import { SigilDefs } from "../components/Sigils";
import { CogitatorIcon, HourglassIcon, PopOutIcon, StylusIcon } from "../components/Icons";
import Dashboard from "./Dashboard";
import DataStylus from "../widgets/DataStylus";
import ChronoSiphon from "../widgets/ChronoSiphon";
import { openWidget, usePopOuts } from "../lib/widgets";
import { useSharedTimer } from "../lib/timer";

type Page = "cogitator" | "data-stylus" | "chrono-siphon";
const PAGE_KEY = "cogitorium.page";

const PAGES: { id: Page; label: string; icon: ReactNode; hint: string }[] = [
  { id: "cogitator", label: "Cogitator", icon: <CogitatorIcon size={20} />, hint: "Your record" },
  { id: "data-stylus", label: "Data Stylus", icon: <StylusIcon size={20} />, hint: "Tasks and subtasks" },
  { id: "chrono-siphon", label: "Chrono-Siphon", icon: <HourglassIcon size={20} />, hint: "Focus timer" },
];

function readPage(): Page {
  try {
    const p = localStorage.getItem(PAGE_KEY) as Page | null;
    return p && PAGES.some((x) => x.id === p) ? p : "cogitator";
  } catch {
    return "cogitator";
  }
}

/**
 * The main Cogitorium window. One app with three sections: the Cogitator
 * dashboard (home), the Data Stylus and the Chrono-Siphon. On the desktop a
 * section can be popped out as its own widget window; both stay in sync.
 * Narrow windows (and phones) get a bottom tab bar instead of the sidebar.
 */
export default function AppShell() {
  const [page, setPage] = useState<Page>(readPage);
  const { canPopOut, open } = usePopOuts();
  const [popError, setPopError] = useState("");
  // The main window always watches the timer, so it tolls on any page.
  useSharedTimer({ watch: true });

  useEffect(() => {
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch {
      /* ignore */
    }
    setPopError("");
  }, [page]);

  const current = PAGES.find((p) => p.id === page)!;

  return (
    <div className="widget app">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <SigilDefs />
      </svg>
      <TitleBar title="Cogitorium" icon={<CogitatorIcon size={14} />} />
      <div className="shell">
        <nav className="nav" aria-label="Sections">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={p.id === page ? "nav-item on" : "nav-item"}
              aria-current={p.id === page ? "page" : undefined}
              title={p.hint}
              onClick={() => setPage(p.id)}
            >
              {p.icon}
              <span className="nav-label">{p.label}</span>
              {open.includes(p.id) && <span className="nav-dot" title="Also open as a widget" />}
            </button>
          ))}
        </nav>

        <section className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">{current.label}</h1>
              <p className="page-hint">
                {current.hint}
                {open.includes(page) && " · also open as a widget"}
              </p>
            </div>
            {canPopOut && page !== "cogitator" && (
              <button
                className="btn quiet pop-out"
                title="Open this section in its own small window"
                onClick={() => openWidget(page as "data-stylus" | "chrono-siphon").catch((e) => setPopError(String(e)))}
              >
                <PopOutIcon size={14} />
                <span>Pop out</span>
              </button>
            )}
          </header>
          {popError && <p className="footnote error">{popError}</p>}
          <div className="page-body">
            {page === "cogitator" ? (
              <Dashboard onOpen={setPage} />
            ) : (
              <div className="column">{page === "data-stylus" ? <DataStylus /> : <ChronoSiphon />}</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
