/**
 * Surgical source-code patching helpers used by the fixer.
 *
 * Every helper returns the *exact* `find`/`replace` strings it used, so the
 * changeset can show a real diff instead of a vague "code updated" note.
 */

export interface PatchEdit {
  changed: boolean;
  content: string;
  /** Text that was removed (empty for pure appends). */
  find?: string;
  /** Text that was inserted. */
  replace?: string;
  detail?: string;
}

const NO_CHANGE: Omit<PatchEdit, 'content'> = { changed: false };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locate a `// >>> MARKER >>>` … `// <<< MARKER <<<` region. */
export function findMarkerRegion(content: string, startMarker: string, endMarker: string): { start: number; end: number } | null {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end: end + endMarker.length };
}

/**
 * Replace the text between two markers (inclusive). Returns `changed: false`
 * when the markers are absent so the caller can decide what to do.
 */
export function replaceBetweenMarkers(content: string, startMarker: string, endMarker: string, block: string): PatchEdit {
  const region = findMarkerRegion(content, startMarker, endMarker);
  if (!region) return { ...NO_CHANGE, content };
  const find = content.slice(region.start, region.end);
  if (find === block) return { ...NO_CHANGE, content, detail: 'marker block already up to date' };
  return {
    changed: true,
    content: `${content.slice(0, region.start)}${block}${content.slice(region.end)}`,
    find,
    replace: block,
    detail: `replaced managed block ${startMarker}`,
  };
}

/** Index of the `{` that opens a function body, plus its matching `}`. */
export function findFunctionBody(content: string, functionName: string): { bodyStart: number; bodyEnd: number; braceOpen: number } | null {
  const pattern = new RegExp(`\\b(?:void|int|bool|auto|static|inline|unsigned|long|float|double)?\\s*${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = pattern.exec(content);
  if (!match) return null;

  const braceOpen = match.index + match[0].length - 1;
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = braceOpen; index < content.length; index += 1) {
    const char = content[index] as string;
    const next = content[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return { bodyStart: braceOpen + 1, bodyEnd: index, braceOpen };
    }
  }
  return null;
}

export function hasFunction(content: string, functionName: string): boolean {
  return findFunctionBody(content, functionName) !== null;
}

/**
 * Replace the body of `void setup()` / `void loop()` while keeping the
 * signature and braces intact.
 */
export function replaceFunctionBody(content: string, functionName: string, body: string): PatchEdit {
  const region = findFunctionBody(content, functionName);
  if (!region) return { ...NO_CHANGE, content, detail: `${functionName}() not found` };

  const find = content.slice(region.bodyStart, region.bodyEnd);
  const replacement = `\n${body.trimEnd()}\n`;
  if (find.trim() === replacement.trim()) return { ...NO_CHANGE, content, detail: `${functionName}() body unchanged` };

  return {
    changed: true,
    content: `${content.slice(0, region.bodyStart)}${replacement}${content.slice(region.bodyEnd)}`,
    find,
    replace: replacement,
    detail: `replaced ${functionName}() body`,
  };
}

/** Append `snippet` when `guard` is not present yet. */
export function appendWhenMissing(content: string, guard: RegExp | string, snippet: string): PatchEdit {
  const present = typeof guard === 'string' ? content.includes(guard) : guard.test(content);
  if (present) return { ...NO_CHANGE, content, detail: 'already present' };
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  return {
    changed: true,
    content: `${content}${separator}${snippet.trimStart()}`,
    replace: `${separator}${snippet.trimStart()}`,
    detail: 'appended missing block',
  };
}

/** Insert a `#include <Header.h>` line after the last existing include. */
export function insertInclude(content: string, statement: string): PatchEdit {
  if (content.includes(statement)) return { ...NO_CHANGE, content, detail: 'include already present' };

  const includePattern = /^[ \t]*#\s*include\b.*$/gm;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(content)) !== null) last = match;

  if (last) {
    const at = last.index + last[0].length;
    return {
      changed: true,
      content: `${content.slice(0, at)}\n${statement}${content.slice(at)}`,
      find: last[0],
      replace: `${last[0]}\n${statement}`,
      detail: `inserted ${statement}`,
    };
  }

  return {
    changed: true,
    content: `${statement}\n\n${content}`,
    replace: `${statement}\n\n`,
    detail: `prepended ${statement}`,
  };
}

/** Remove an include line (used when a library is dropped). */
export function removeInclude(content: string, header: string): PatchEdit {
  const pattern = new RegExp(`^[ \\t]*#\\s*include\\s*[<"]${escapeRegExp(header)}[>"][ \\t]*\\r?\\n?`, 'm');
  const match = pattern.exec(content);
  if (!match) return { ...NO_CHANGE, content, detail: `no include for ${header}` };
  return {
    changed: true,
    content: content.replace(pattern, ''),
    find: match[0],
    replace: '',
    detail: `removed ${match[0].trim()}`,
  };
}

/** Literal find/replace — the model's `patch_code_file` op. */
export function findReplace(content: string, find: string, replace: string): PatchEdit {
  if (find.length === 0) return { ...NO_CHANGE, content, detail: 'empty find string' };
  const index = content.indexOf(find);
  if (index === -1) return { ...NO_CHANGE, content, detail: 'search text not found' };
  return {
    changed: true,
    content: `${content.slice(0, index)}${replace}${content.slice(index + find.length)}`,
    find,
    replace,
    detail: 'literal find/replace',
  };
}

/** Regex replace (first match only — fixes must stay predictable). */
export function regexReplace(content: string, pattern: string, replace: string): PatchEdit {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'm');
  } catch {
    return { ...NO_CHANGE, content, detail: `invalid regular expression: ${pattern}` };
  }
  const match = regex.exec(content);
  if (!match) return { ...NO_CHANGE, content, detail: 'pattern did not match' };
  return {
    changed: true,
    content: content.replace(regex, replace),
    find: match[0],
    replace,
    detail: 'regex replace',
  };
}
