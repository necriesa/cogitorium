/**
 * Data Stylus scrolls: a task broken down into subtasks, stored in the vault as
 * a Markdown checklist so ticks show up in Obsidian (and ticks made in
 * Obsidian come back to the widget).
 */

export type Rite = { text: string; done: boolean; depth: number };
export type Scroll = { title: string; items: Rite[]; file: string; created: string };

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** Indent depth: a tab or 2+ spaces per level, capped at 3. */
function depthOf(indent: string): number {
  const width = indent.replace(/\t/g, "    ").length;
  return Math.min(3, Math.floor(width / 2));
}

function tidy(s: string): string {
  const t = s.trim().replace(/\s+/g, " ").replace(/[.;,]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Splits prose into steps on sentence ends, semicolons, and "then" / "after that" / "next" / "finally". */
export function splitProse(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .flatMap((part) => part.split(/,?\s+(?:and then|then|after that|afterwards|next|finally)\s+/i))
    .map((s) => s.trim().replace(/^(?:and then|then|after that|afterwards|next|finally|also)\b[,\s]*/i, ""))
    .map(tidy)
    .filter((s) => s.length > 1);
}

/**
 * Breaks pasted text into a title and subtasks.
 * - Bullets, numbered lines and checkboxes become subtasks (indentation = nesting, ticks kept).
 * - A heading, or a plain line before the first bullet, becomes the title.
 * - Pure prose is split into steps with splitProse.
 * `titleHint` (from the Task field) wins over anything found in the text.
 */
export function breakDown(text: string, titleHint = ""): { title: string; items: Rite[] } {
  const lines = stripFrontmatter(text).split(/\r?\n/);
  let title = titleHint.trim();
  const items: Rite[] = [];
  const hasList = lines.some((l) => LIST_ITEM.test(l));

  if (hasList) {
    let seenList = false;
    for (const raw of lines) {
      if (!raw.trim() || raw.trim().startsWith(">")) continue;
      const heading = raw.trim().match(HEADING);
      if (heading) {
        if (!title) title = heading[1].trim();
        continue;
      }
      const li = raw.match(LIST_ITEM);
      if (li) {
        seenList = true;
        if (li[3].trim()) items.push({ text: li[3].trim(), done: !!li[2] && li[2] !== " ", depth: depthOf(li[1]) });
      } else if (!seenList) {
        if (!title) title = tidy(raw).replace(/:$/, "");
      } else {
        items.push({ text: tidy(raw), done: false, depth: 0 });
      }
    }
  } else {
    const body: string[] = [];
    for (const raw of lines) {
      const heading = raw.trim().match(HEADING);
      if (heading) {
        if (!title) title = heading[1].trim();
      } else if (!raw.trim().startsWith(">")) {
        body.push(raw);
      }
    }
    let steps = splitProse(body.join("\n"));
    // "Task name: step one. Step two." -> the part before the colon is the title.
    if (!title && steps.length && /^[^:]{3,60}:\s+\S/.test(steps[0])) {
      const [head, ...rest] = steps[0].split(/:\s+/);
      title = head;
      steps = [tidy(rest.join(": ")), ...steps.slice(1)];
    }
    for (const s of steps) items.push({ text: s, done: false, depth: 0 });
  }

  if (!title) {
    const words = (items[0]?.text ?? "Untitled task").split(" ");
    title = words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
  }
  return { title, items };
}

/** A safe Windows/Obsidian file name for a scroll title. */
export function fileNameFor(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  return `${base || "Untitled task"}.md`;
}

/** The scroll as a Markdown note: frontmatter, title, checklist. */
export function toMarkdown(scroll: Scroll, now: Date = new Date()): string {
  const done = scroll.items.filter((i) => i.done).length;
  const stamp = `${now.toLocaleDateString("en-CA")} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  const lines = [
    "---",
    "type: data-stylus-scroll",
    `created: ${scroll.created}`,
    `updated: ${stamp}`,
    `progress: ${done}/${scroll.items.length}`,
    "---",
    `# ${scroll.title}`,
    "",
    ...scroll.items.map((i) => `${"  ".repeat(i.depth)}- [${i.done ? "x" : " "}] ${i.text}`),
    "",
  ];
  return lines.join("\n");
}

/** Reads a scroll note back (e.g. after it was ticked in Obsidian). */
export function fromMarkdown(markdown: string, file: string, created: string): Scroll {
  const { title, items } = breakDown(markdown);
  const createdMatch = markdown.match(/^created:\s*(.+)$/m);
  return { title, items, file, created: createdMatch?.[1].trim() ?? created };
}
