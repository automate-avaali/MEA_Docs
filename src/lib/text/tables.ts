// Repairs Markdown tables produced by OCR so an LLM can read them unambiguously.
//
// Typical OCR output for a two-level header (each slab has Volume + Off-Invoice):
//   | Category | Pack | Slab A | Slab B | Slab C |                 ← 5 cells
//   | :--- | :--- | :--- | :--- | :--- |
//   | Volume | Off-Invoice | Volume | Off-Invoice | Volume | Off-Invoice |   ← sub-header, 6 cells
//   | CSD | CAN 185ml x 12 | 0 - 1,000 | 0.87 | 1,000 - 2,000 | 1.52 | 2,000+ | 2.17 |   ← 8 cells
//   |  | CAN 240ml x 30 | 0 - 200 | 1.09 | …                                      ← category left blank
// becomes
//   | Category | Pack | Slab A Volume | Slab A Off-Invoice | Slab B Volume | … |
//   | --- | --- | --- | … |
//   | CSD | CAN 185ml x 12 | 0 - 1,000 | 0.87 | … |
//   | CSD | CAN 240ml x 30 | 0 - 200 | 1.09 | … |
// Without this, models mix up which number belongs to which column (seen: volumes and discounts on
// alternating rows) and lose the category of most rows.

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cellsOf = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const hasNumber = (cells: string[]) => cells.some((c) => /\d/.test(c));

function fixTable(lines: string[]): string[] {
  let rows = lines.filter((l) => !isSep(l)).map(cellsOf);
  if (rows.length < 2) return lines;
  const width = Math.max(...rows.map((r) => r.length));
  let header = rows[0];
  rows = rows.slice(1);

  // Two-level header: a text-only row right after the header, wider than the header's tail.
  if (header.length < width && rows[0] && !hasNumber(rows[0])) {
    const sub = rows[0].filter((c) => c !== "");
    const lead = width - sub.length; // leading columns that have no sub-header (e.g. Category, Pack)
    const parents = header.slice(lead).filter((c) => c !== "");
    if (lead >= 0 && parents.length && sub.length % parents.length === 0) {
      const span = sub.length / parents.length;
      header = [...header.slice(0, lead), ...sub.map((s, k) => `${parents[Math.floor(k / span)]} ${s}`)];
      rows = rows.slice(1);
    }
  }

  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill("")].slice(0, width);
  header = pad(header);
  // Forward-fill the first column (group labels like CSD / LIT / STING are written once per group).
  let last = "";
  rows = rows.map((r) => {
    const p = pad(r);
    if (p[0]) last = p[0];
    else if (last && p.slice(1).some((c) => c)) p[0] = last;
    return p;
  });
  const fmt = (r: string[]) => `| ${r.join(" | ")} |`;
  return [fmt(header), fmt(header.map(() => "---")), ...rows.map(fmt)];
}

export function normalizeTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!isRow(lines[i]) && !isSep(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && (isRow(lines[i]) || isSep(lines[i]))) block.push(lines[i++]);
    out.push(...fixTable(block));
  }
  return out.join("\n");
}
