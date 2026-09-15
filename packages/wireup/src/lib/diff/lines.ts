/**
 * Line-based diff (LCS).
 *
 * Shared by the firmware workbench on both sides: the server computes the
 * unified diff of an applied change and stores it on the chat message, the
 * client renders it. Dynamic-programming LCS with the classic guard: files
 * above `MAX_LINES` are diffed by common prefix/suffix trimming only, which
 * is exact for the neighbouring-edit cases that matter and merely
 * conservative (over-reporting) for pathological rewrites.
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 1-based line in the old file (`del`/`same`). */
  oldLine?: number;
  /** 1-based line in the new file (`add`/`same`). */
  newLine?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
}

const MAX_LINES = 4000;

export function diffLines(oldText: string, newText: string): DiffResult {
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  /* Common prefix/suffix trim first — cheap and shrinks the LCS table. */
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const pushSame = (from: number, to: number, offsetOld: number, offsetNew: number): void => {
    for (let i = from; i < to; i += 1) {
      lines.push({ kind: 'same', text: a[i] ?? '', oldLine: offsetOld + i + 1, newLine: offsetNew + i + 1 });
    }
  };

  pushSame(0, start, 0, 0);

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length === 0 || midB.length === 0) {
    for (let i = 0; i < midA.length; i += 1) {
      lines.push({ kind: 'del', text: midA[i] ?? '', oldLine: start + i + 1 });
      removed += 1;
    }
    for (let i = 0; i < midB.length; i += 1) {
      lines.push({ kind: 'add', text: midB[i] ?? '', newLine: start + i + 1 });
      added += 1;
    }
  } else if (midA.length + midB.length > MAX_LINES) {
    /* Too big for a table: report as one wholesale replacement. */
    for (let i = 0; i < midA.length; i += 1) {
      lines.push({ kind: 'del', text: midA[i] ?? '', oldLine: start + i + 1 });
      removed += 1;
    }
    for (let i = 0; i < midB.length; i += 1) {
      lines.push({ kind: 'add', text: midB[i] ?? '', newLine: start + i + 1 });
      added += 1;
    }
  } else {
    /* LCS table. */
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table: Uint32Array[] = new Array(rows);
    for (let i = 0; i < rows; i += 1) table[i] = new Uint32Array(cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i]![j] = midA[i] === midB[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        lines.push({ kind: 'same', text: midA[i] ?? '', oldLine: start + i + 1, newLine: start + j + 1 });
        i += 1;
        j += 1;
      } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
        lines.push({ kind: 'del', text: midA[i] ?? '', oldLine: start + i + 1 });
        removed += 1;
        i += 1;
      } else {
        lines.push({ kind: 'add', text: midB[j] ?? '', newLine: start + j + 1 });
        added += 1;
        j += 1;
      }
    }
    for (; i < midA.length; i += 1) {
      lines.push({ kind: 'del', text: midA[i] ?? '', oldLine: start + i + 1 });
      removed += 1;
    }
    for (; j < midB.length; j += 1) {
      lines.push({ kind: 'add', text: midB[j] ?? '', newLine: start + j + 1 });
      added += 1;
    }
  }

  pushSame(endA, a.length, 0, 0);

  return { lines, added, removed };
}

/** Collapse long runs of unchanged lines into `…` separators for display. */
export function collapseContext(lines: DiffLine[], context = 3): (DiffLine | { kind: 'gap'; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i += 1) keep[i] = true;
  });

  const out: (DiffLine | { kind: 'gap'; count: number })[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (gap > 0) {
        out.push({ kind: 'gap', count: gap });
        gap = 0;
      }
      out.push(line);
    } else {
      gap += 1;
    }
  });
  if (gap > 0) out.push({ kind: 'gap', count: gap });
  return out;
}
