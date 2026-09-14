import type { FileNode } from "@forge/shared";

/**
 * Pure helpers for the explorer tree.
 *
 * Kept free of React and of the store so they can be unit tested (and so the
 * tree component stays about rendering). Paths are always absolute, exactly as
 * the main process returns them from `fs:listDir`.
 */

const BACKSLASH = "\\";
const WINDOWS_RESERVED_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const MAX_NAME_LENGTH = 255;
const CONTROL_CHARS = /[\u0000-\u001f]/;

/** True when the renderer is running on Windows (Explorer/Device path rules). */
export function isWindowsHost(): boolean {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "";
  return /windows|win32|win64/i.test(agent);
}

/** Separator a path was produced with: `\` on Windows, `/` elsewhere. */
export function separatorFor(path: string): string {
  return path.lastIndexOf(BACKSLASH) > path.lastIndexOf("/") ? BACKSLASH : "/";
}

export function baseName(path: string, sep = separatorFor(path)): string {
  const index = path.lastIndexOf(sep);
  return index < 0 ? path : path.slice(index + sep.length);
}

export function dirName(path: string, sep = separatorFor(path)): string {
  const index = path.lastIndexOf(sep);
  if (index < 0) return path;
  const parent = path.slice(0, index);
  // Never strip the separator of a root ("/x" or "C:\x").
  return parent === "" || parent.endsWith(":") ? parent + sep : parent;
}

export function joinPath(parent: string, name: string, sep = separatorFor(parent)): string {
  if (!parent) return name;
  const endsWithSeparator = parent.endsWith(sep) || parent.endsWith("/") || parent.endsWith(BACKSLASH);
  return endsWithSeparator ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/** True when `child` is `parent` itself or lives somewhere underneath it. */
export function isInside(parent: string, child: string, sep = separatorFor(parent)): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Rewrite `target` when it is `oldPrefix` or lives under it; null otherwise. */
export function replacePrefix(target: string, oldPrefix: string, newPrefix: string, sep = separatorFor(target)): string | null {
  if (target === oldPrefix) return newPrefix;
  const boundary = oldPrefix.endsWith(sep) ? oldPrefix : `${oldPrefix}${sep}`;
  return target.startsWith(boundary) ? `${newPrefix}${sep}${target.slice(boundary.length)}` : null;
}

/**
 * Validate a name typed into the explorer's inline input.
 * Returns a human-readable problem, or null when the name is usable.
 *
 * Nested names ("src/new/nested.ts") are allowed — the main process creates the
 * missing parents — so every segment is checked on its own.
 */
export function validateEntryName(name: string, options: { isWindows?: boolean } = {}): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  const windows = options.isWindows ?? isWindowsHost();
  const segments = trimmed.split(windows ? /[\\/]/ : "/");
  if (segments.some((segment) => segment === "")) return "Names cannot contain empty path segments.";
  for (const segment of segments) {
    if (segment.length > MAX_NAME_LENGTH) return "That name is too long (255 characters per segment).";
    if (segment === "." || segment === "..") return "Names cannot be '.' or '..'.";
    if (CONTROL_CHARS.test(segment)) return "Names cannot contain control characters.";
    if (windows) {
      if (WINDOWS_RESERVED_CHARS.test(segment)) return "Names cannot contain < > : \" | ? or * on Windows.";
      const device = (segment.toUpperCase().split(".")[0] ?? "").trim();
      if (WINDOWS_RESERVED_NAMES.has(device)) return `"${segment}" is a reserved device name on Windows.`;
      if (/[. ]$/.test(segment)) return "Names cannot end with a dot or a space on Windows.";
    }
  }
  return null;
}

export function findNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

export function hasNode(nodes: FileNode[], path: string): boolean {
  return findNode(nodes, path) !== undefined;
}

/** Collapse everything (children are dropped, not emptied). */
export function clearChildren(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => (node.isDirectory ? { ...node, children: undefined } : node));
}

/**
 * Deepest directory in the tree that contains `path`, or null when only the
 * workspace root does. Used to refresh the smallest subtree that can show a
 * newly created (possibly nested) entry.
 */
export function nearestKnownAncestor(nodes: FileNode[], path: string, sep = separatorFor(path)): string | null {
  const parts = path.split(sep).filter(Boolean);
  let best: string | null = null;
  for (let count = 1; count < parts.length; count++) {
    const candidate = (path.startsWith(sep) ? sep : "") + parts.slice(0, count).join(sep);
    if (hasNode(nodes, candidate)) best = candidate;
  }
  return best;
}

/**
 * Rewrite the paths of a renamed subtree. Branches that are not inside it are
 * returned untouched, so the rest of the tree keeps its expansion state.
 */
export function remapSubtree(nodes: FileNode[], oldPrefix: string, newPrefix: string, sep = separatorFor(oldPrefix)): FileNode[] {
  let changed = false;
  const remapped = nodes.map((node) => {
    const path = replacePrefix(node.path, oldPrefix, newPrefix, sep);
    if (path) {
      changed = true;
      return {
        ...node,
        path,
        name: baseName(path, sep),
        ...(node.children ? { children: remapSubtree(node.children, oldPrefix, newPrefix, sep) } : {}),
      };
    }
    // The renamed folder can be deeper down: keep looking, but hand back the
    // very same array when nothing below changed.
    if (node.children) {
      const children = remapSubtree(node.children, oldPrefix, newPrefix, sep);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? remapped : nodes;
}
