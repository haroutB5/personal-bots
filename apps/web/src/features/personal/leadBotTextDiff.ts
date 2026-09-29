export interface LeadBotDiffLine {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

/** Above this many line pairs the table is not built: everything old is removed, everything new added. */
const MAX_CELLS = 4_000_000;

/**
 * A plain line diff of two texts (longest common subsequence), for the owner to
 * read what a rewrite removes and adds. Text is kept exactly as stored, line by
 * line; nothing is trimmed or interpreted.
 */
export function leadBotTextDiff(before: string, after: string): ReadonlyArray<LeadBotDiffLine> {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Lines the two texts share at the start and end are the same, whatever lies between.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: Array<LeadBotDiffLine> = a.slice(0, head).map((text) => ({ kind: "same", text }));

  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) out.push({ kind: "removed", text });
    for (const text of midB) out.push({ kind: "added", text });
  } else {
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i]! });
        i++;
        j++;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        out.push({ kind: "removed", text: midA[i]! });
        i++;
      } else {
        out.push({ kind: "added", text: midB[j]! });
        j++;
      }
    }
    for (; i < midA.length; i++) out.push({ kind: "removed", text: midA[i]! });
    for (; j < midB.length; j++) out.push({ kind: "added", text: midB[j]! });
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
  return out;
}
