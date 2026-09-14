/**
 * Prompt 6 — small dependency-free fuzzy matcher for the command palette and
 * quick-open. Subsequence match (like VS Code / fzf) with bonuses for
 * consecutive matches and matches right after a separator or at camelCase
 * humps. Returns a score (higher is better) or -1 when there is no match.
 *
 * Implemented locally rather than pulling in `cmdk`: the palette overlay only
 * needs this scoring helper plus a list, and keeping Forge dependency-free
 * here means the renderer builds with zero additional installs.
 */
export function fuzzyScore(query: string, candidate: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = candidate.toLowerCase();

  let score = 0;
  let lastMatchIndex = -2;
  let needleIndex = 0;

  for (let i = 0; i < haystack.length && needleIndex < needle.length; i++) {
    if (haystack[i] !== needle[needleIndex]) continue;

    let charScore = 1;
    if (i === 0) {
      charScore += 8; // start of the string
    } else {
      const previous = candidate[i - 1];
      if (["/", "\\", " ", "-", "_", "."].includes(previous)) charScore += 6; // word start
      if (previous === previous.toLowerCase() && candidate[i] === candidate[i].toUpperCase()) charScore += 4; // camelCase
    }
    if (lastMatchIndex === i - 1) charScore += 5; // consecutive run
    if (i < needle.length && haystack.startsWith(needle)) charScore += 10; // exact prefix

    score += charScore;
    lastMatchIndex = i;
    needleIndex++;
  }

  if (needleIndex < needle.length) return -1;
  // Prefer shorter candidates: ties go to tight matches.
  return score - haystack.length * 0.01;
}

/** Rank + filter a list; returns items sorted best-first with their scores. */
export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, text(item)) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}
