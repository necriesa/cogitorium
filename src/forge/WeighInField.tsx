import { useEffect, useRef, useState } from "react";
import { fmt, setBodyweight, type WeighIn } from "../lib/forge";

type Props = {
  date: string;
  weighIns: WeighIn[];
  /** Shown before the box. */
  label?: string;
};

function parse(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() && Number.isFinite(n) ? n : null;
}

/**
 * The weigh-in for one day, saved to `Flesh-Forge/Bodyweight.md` a moment
 * after you stop typing (an empty box removes it). The placeholder is your
 * last weigh-in before that day.
 */
export default function WeighInField({ date, weighIns, label = "Bodyweight" }: Props) {
  const logged = weighIns.find((w) => w.date === date)?.kg ?? null;
  const previous = [...weighIns].reverse().find((w) => w.date < date)?.kg ?? null;
  const [text, setText] = useState(logged == null ? "" : fmt(logged));
  const [note, setNote] = useState("");
  const timer = useRef(0);
  const editing = useRef(false);

  // Follow the log (another window, or a new day) unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(logged == null ? "" : fmt(logged));
  }, [logged, date]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function save(value: string) {
    const kg = parse(value);
    if (value.trim() && (kg == null || kg < 20 || kg > 400)) {
      setNote("20-400 kg");
      return;
    }
    if (kg === logged) {
      editing.current = false;
      return;
    }
    setBodyweight(date, kg)
      .then(() => setNote(kg == null ? "removed" : "logged"))
      .catch((err) => setNote(String(err)))
      .finally(() => (editing.current = false));
  }

  return (
    <label className="forge-weigh">
      <span className="term-label">{label}</span>
      <input
        className="term-input forge-num"
        inputMode="decimal"
        value={text}
        placeholder={previous != null ? fmt(previous) : "–"}
        aria-label={`${label} on ${date} in kg`}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
          setNote("");
          window.clearTimeout(timer.current);
          const value = e.target.value;
          timer.current = window.setTimeout(() => save(value), 800);
        }}
        onBlur={() => {
          window.clearTimeout(timer.current);
          if (editing.current) save(text);
        }}
      />
      <span className="forge-unit">kg</span>
      {note && <span className="forge-unit forge-weigh-note">{note}</span>}
    </label>
  );
}
