import { useEffect, useState, type ReactNode } from "react";
import TitleBar from "./TitleBar";
import { chooseVault, getVault, onVaultChanged } from "../lib/vault";

type Props = { title: string; icon: ReactNode; children: ReactNode };

/**
 * Shows the widget once a vault folder is known. On first run (nothing saved
 * yet) it asks for the folder instead; the choice is remembered by the app,
 * and every open widget picks it up at once.
 */
export default function VaultGate({ title, icon, children }: Props) {
  const [vault, setVault] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    getVault()
      .then(setVault)
      .catch(() => setVault(null));
    return onVaultChanged(setVault);
  }, []);

  async function pick() {
    setError("");
    try {
      const chosen = await chooseVault();
      if (chosen) setVault(chosen);
    } catch (err) {
      setError(String(err));
    }
  }

  if (vault === undefined) return <div className="widget" />;
  if (vault) return <>{children}</>;

  return (
    <div className="widget">
      <TitleBar title={title} icon={icon} />
      <main className="body gate">
        <section className="cogitator gate-panel">
          <p className="gate-head">No vault bound</p>
          <p className="gate-text">
            Couldn't tell which Obsidian vault to use. Choose the one the widgets write to; logs and scrolls go in{" "}
            <span className="gate-path">Sources/Journal/Widgets</span> inside it.
          </p>
        </section>
        <div className="actions">
          <button className="btn primary" onClick={pick}>
            Choose vault folder
          </button>
        </div>
        <p className="footnote">Remembered for next time. Change it later with the folder button in the title bar.</p>
        {error && <p className="footnote error">{error}</p>}
      </main>
    </div>
  );
}
