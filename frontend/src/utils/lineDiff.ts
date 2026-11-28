/**
 * A line diff for the post history view (NF-9).
 *
 * The compare view shows how the body of a revision differs from the post in
 * the editor. Post bodies are short markdown, so a plain longest-common-
 * subsequence table over the lines is enough. The common head and tail are cut
 * off first, so a small edit in a long post makes a small table. When the
 * changed middle is still too large for the table, the middle is reported as
 * removed and then added: the view stays correct, only less precise.
 */

/** One line of a diff: in both texts, only in the first, or only in the second. */
export interface DiffLine {
  op: 'same' | 'del' | 'add';
  text: string;
}

/** A run of unchanged lines that the view folds away. */
export interface DiffFold {
  op: 'fold';
  count: number;
}

/** The largest LCS table (rows × columns) that lineDiff builds. */
const MAX_TABLE_CELLS = 1_000_000;

/** Split text into lines. An empty text has no lines. */
function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Diff text `a` against text `b`, line by line. A "del" line is only in `a`,
 * an "add" line is only in `b`.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const al = splitLines(a);
  const bl = splitLines(b);

  let head = 0;
  while (head < al.length && head < bl.length && al[head] === bl[head]) head++;
  let tail = 0;
  while (tail < al.length - head && tail < bl.length - head
    && al[al.length - 1 - tail] === bl[bl.length - 1 - tail]) tail++;

  const out: DiffLine[] = al.slice(0, head).map(text => ({ op: 'same' as const, text }));
  const am = al.slice(head, al.length - tail);
  const bm = bl.slice(head, bl.length - tail);
  out.push(...diffMiddle(am, bm));
  out.push(...al.slice(al.length - tail).map(text => ({ op: 'same' as const, text })));
  return out;
}

/** The LCS diff of two line lists that share no head or tail. */
function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_TABLE_CELLS) {
    return [
      ...a.map(text => ({ op: 'del' as const, text })),
      ...b.map(text => ({ op: 'add' as const, text })),
    ];
  }
  // lcs[i][j] is the LCS length of a[i..] and b[j..], in one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ op: 'del', text: a[i++] });
    } else {
      out.push({ op: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}

/**
 * Fold the long unchanged runs of a diff. `context` unchanged lines stay next
 * to each change; the rest of a run becomes one fold. A diff with no change
 * folds to nothing but one fold.
 */
export function foldUnchanged(lines: DiffLine[], context = 2): Array<DiffLine | DiffFold> {
  const out: Array<DiffLine | DiffFold> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== 'same') {
      out.push(lines[i++]);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].op === 'same') end++;
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = end === lines.length ? 0 : context;
    if (end - i > keepBefore + keepAfter) {
      out.push(...lines.slice(i, i + keepBefore));
      out.push({ op: 'fold', count: end - i - keepBefore - keepAfter });
      out.push(...lines.slice(end - keepAfter, end));
    } else {
      out.push(...lines.slice(i, end));
    }
    i = end;
  }
  return out;
}
