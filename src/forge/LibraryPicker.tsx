import { useMemo, useState } from "react";
import { libraryGroups, KIND_LABEL, type LibraryEntry } from "../lib/forge";

type Props = {
  library: LibraryEntry[];
  /** Lower-case names already in the workout, marked as added. */
  added?: string[];
  onPick: (entry: LibraryEntry) => void;
};

/** Search and group filter over the exercise library; a click picks an exercise. */
export function useLibraryFilter(library: LibraryEntry[]) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => libraryGroups(library).map((g) => g.group), [library]);
  const shown = useMemo(
    () =>
      libraryGroups(
        library.filter(
          (e) =>
            (!group || (e.group.trim() || "Other") === group) &&
            (!q || e.name.toLowerCase().includes(q) || e.notes.toLowerCase().includes(q) || e.group.toLowerCase().includes(q)),
        ),
      ),
    [library, group, q],
  );
  return { query, setQuery, group, setGroup, groups, shown };
}

export function GroupChips({ groups, group, setGroup }: { groups: string[]; group: string | null; setGroup: (g: string | null) => void }) {
  return (
    <div className="chips forge-groups" role="group" aria-label="Muscle group">
      <button className={group == null ? "chip on" : "chip"} aria-pressed={group == null} onClick={() => setGroup(null)}>
        All
      </button>
      {groups.map((g) => (
        <button key={g} className={g === group ? "chip on" : "chip"} aria-pressed={g === group} onClick={() => setGroup(g === group ? null : g)}>
          {g}
        </button>
      ))}
    </div>
  );
}

export default function LibraryPicker({ library, added = [], onPick }: Props) {
  const { query, setQuery, group, setGroup, groups, shown } = useLibraryFilter(library);
  if (library.length === 0) return <p className="dash-empty">The library is empty. Add exercises in the Library tab.</p>;
  return (
    <div className="forge-picker">
      <input
        className="term-input"
        value={query}
        placeholder="search the library"
        aria-label="Search the exercise library"
        onChange={(e) => setQuery(e.target.value)}
      />
      <GroupChips groups={groups} group={group} setGroup={setGroup} />
      <div className="forge-picker-list">
        {shown.length === 0 && <p className="dash-empty">No exercise matches.</p>}
        {shown.map((g) => (
          <div key={g.group}>
            <p className="term-label forge-group-label">{g.group}</p>
            <ul className="library">
              {g.entries.map((e) => {
                const isAdded = added.includes(e.name.toLowerCase());
                return (
                  <li key={e.name}>
                    <button className={isAdded ? "library-entry lib-open" : "library-entry"} onClick={() => onPick(e)} title={e.notes || undefined}>
                      <span className="lib-title">{e.name}</span>
                      <span className="lib-meta">
                        {e.target || KIND_LABEL[e.kind]}
                        {isAdded && " · added"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
