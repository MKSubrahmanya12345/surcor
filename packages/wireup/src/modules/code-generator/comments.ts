/**
 * C/C++ comment removal.
 *
 * The validator checks requirement coverage by matching the brief's terms
 * against the design (see `analyzeCoverage`). The sketch builder writes a
 * machine-managed header at the top of every file that restates the user's
 * prompt and the extracted behaviours — useful to a human reading the file,
 * useless as evidence. Left in the corpus it made every requirement "covered"
 * by the agent quoting the brief back at itself: a build that contained no
 * line sensor at all passed `It should follow a black line on white floor`
 * with a token ratio of 5/5.
 *
 * Comments are documentation, not implementation. This scanner removes them
 * before any text-matching pass reads the source, so only real code can
 * satisfy a requirement.
 *
 * It respects string and character literals (including escapes), so a `"//"`
 * inside a telemetry string or a `'/'` in a char literal is not mistaken for
 * the start of a comment.
 */

/**
 * Strip `/* … *\/` and `// …` from C/C++ source, preserving string and char
 * literals verbatim.
 *
 * Line endings are preserved so a caller can still index lines reliably; only
 * comment characters are replaced (block comments keep their newline layout).
 */
export function stripCodeComments(source: string): string {
  if (!source) return '';

  let out = '';
  let i = 0;
  const length = source.length;

  while (i < length) {
    const char = source[i] as string;
    const next = i + 1 < length ? (source[i + 1] as string) : '';

    /* --- line comment: runs to the end of the line --- */
    if (char === '/' && next === '/') {
      while (i < length && source[i] !== '\n') i += 1;
      continue;
    }

    /* --- block comment: keep newlines so line numbering survives --- */
    if (char === '/' && next === '*') {
      i += 2;
      while (i < length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          break;
        }
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }

    /* --- string literal: copy verbatim, honouring backslash escapes --- */
    if (char === '"' || char === "'") {
      const quote = char;
      out += char;
      i += 1;
      while (i < length) {
        const current = source[i] as string;
        if (current === '\\' && i + 1 < length) {
          out += current + (source[i + 1] as string);
          i += 2;
          continue;
        }
        out += current;
        i += 1;
        if (current === quote || current === '\n') break;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}
