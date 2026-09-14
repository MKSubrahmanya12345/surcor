import type { CodeChunk } from "@forge/shared";

/**
 * Naive, dependency-free code chunker.
 *
 * Splitting is on blank-line-separated blocks (function/class-ish boundaries
 * in almost every language), merged up to a token budget. This is deliberately
 * NOT an AST chunker: for retrieval over repos under ~50k lines, block
 * boundaries plus a token budget get you most of the value for none of the
 * tree-sitter build pain.
 */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", vue: "html", svelte: "html", md: "markdown", mdx: "markdown",
  py: "python", pyi: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", pl: "perl", lua: "lua", r: "r", dart: "dart",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell",
  yml: "yaml", yaml: "yaml", xml: "xml", svg: "xml", sql: "sql", toml: "ini",
  ini: "ini", cfg: "ini", conf: "ini", dockerfile: "dockerfile", makefile: "makefile",
  gradle: "groovy", groovy: "groovy", scala: "scala", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", proto: "protobuf", tf: "hcl",
};

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", rakefile: "ruby", gemfile: "ruby",
  justfile: "makefile", cmakeLists: "cmake",
};

export function languageForPath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name];
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "cmakelists.txt") return "cmake";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

/** Rough token count: ~4 characters per token for source code. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface ChunkOptions {
  /** Merge blank-line blocks up to this many estimated tokens. Default 220. */
  maxTokens?: number;
  /** Hard line cap when a single block is larger than the token budget. */
  maxLines?: number;
  /** Safety cap on chunks per file; the budget grows if it would be exceeded. */
  maxChunks?: number;
}

export interface ChunkSpan {
  startLine: number;   // 1-based, inclusive
  endLine: number;     // 1-based, inclusive
  content: string;
  tokenEstimate: number;
}

interface Block {
  startLine: number;
  endLine: number;
  content: string;
  tokens: number;
}

const MIN_MEANINGFUL_CHARS = 12;

function blocksOf(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let start = 0;
  for (let index = 0; index <= lines.length; index++) {
    const isEnd = index === lines.length;
    const isBlank = !isEnd && lines[index].trim() === "";
    if (!isEnd && !isBlank) continue;
    if (index > start) {
      const slice = lines.slice(start, index).join("\n");
      if (slice.replace(/\s/g, "").length >= 2) {
        blocks.push({ startLine: start + 1, endLine: index, content: slice, tokens: estimateTokens(slice) });
      }
    }
    start = index + 1;
  }
  return blocks;
}

function splitOversize(block: Block, maxLines: number, maxTokens: number): Block[] {
  if (block.endLine - block.startLine + 1 <= maxLines) {
    // Few lines but an enormous block (minified bundles, data literals): window
    // by characters so no single embedding request exceeds a model's context.
    if (block.tokens <= maxTokens * 4) return [block];
    const window = maxTokens * 4 * 4; // tokens -> characters
    const pieces: Block[] = [];
    for (let offset = 0; offset < block.content.length; offset += window) {
      const slice = block.content.slice(offset, offset + window);
      if (!slice.trim()) continue;
      pieces.push({ startLine: block.startLine, endLine: block.endLine, content: slice, tokens: estimateTokens(slice) });
    }
    return pieces.length ? pieces : [block];
  }
  const lines = block.content.split("\n");
  const out: Block[] = [];
  for (let offset = 0; offset < lines.length; offset += maxLines) {
    const slice = lines.slice(offset, offset + maxLines).join("\n");
    if (!slice.trim()) continue;
    out.push({
      startLine: block.startLine + offset,
      endLine: block.startLine + offset + slice.split("\n").length - 1,
      content: slice,
      tokens: estimateTokens(slice),
    });
  }
  return out;
}

function mergeBlocks(blocks: Block[], maxTokens: number, maxLines: number): ChunkSpan[] {
  const chunks: ChunkSpan[] = [];
  let current: Block | null = null;
  const flush = (): void => {
    if (!current) return;
    if (current.content.replace(/[^A-Za-z0-9]/g, "").length >= MIN_MEANINGFUL_CHARS) {
      chunks.push({
        startLine: current.startLine, endLine: current.endLine,
        content: current.content, tokenEstimate: current.tokens,
      });
    }
    current = null;
  };
  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    const mergedTokens = estimateTokens(`${current.content}\n\n${block.content}`);
    const mergedLines = block.endLine - current.startLine + 1;
    if (mergedTokens <= maxTokens && mergedLines <= maxLines) {
      // Contiguous when blocks are neighbours; otherwise keep the real source
      // slice so the stored line range still matches the file exactly.
      current = {
        startLine: current.startLine,
        endLine: block.endLine,
        content: block.startLine === current.endLine + 1
          ? `${current.content}\n${block.content}`
          : `${current.content}\n\n${block.content}`,
        tokens: mergedTokens,
      };
      continue;
    }
    flush();
    current = block;
  }
  flush();
  // A single block larger than the budget is windowed by line count.
  const out: ChunkSpan[] = [];
  for (const chunk of chunks) {
    if (chunk.tokenEstimate <= maxTokens * 2) { out.push(chunk); continue; }
    const oversized: Block = {
      startLine: chunk.startLine, endLine: chunk.endLine,
      content: chunk.content, tokens: chunk.tokenEstimate,
    };
    for (const part of splitOversize(oversized, maxLines, maxTokens)) {
      out.push({ startLine: part.startLine, endLine: part.endLine, content: part.content, tokenEstimate: part.tokens });
    }
  }
  return out;
}

/** Split file content into line-ranged chunks under a token budget. */
export function chunkText(content: string, options: ChunkOptions = {}): ChunkSpan[] {
  const maxTokens = options.maxTokens ?? 220;
  const maxLines = options.maxLines ?? 120;
  const maxChunks = options.maxChunks ?? 400;
  if (!content.trim()) return [];
  const blocks = blocksOf(content);
  if (!blocks.length) return [];
  let budget = maxTokens;
  // Pathological files (minified bundles, huge data literals): widen the budget
  // instead of emitting thousands of chunks nobody will read.
  for (let attempt = 0; attempt < 4; attempt++) {
    const chunks = mergeBlocks(blocks, budget, maxLines);
    if (chunks.length <= maxChunks || budget > maxTokens * 16) return chunks;
    budget *= 2;
  }
  return mergeBlocks(blocks, budget, maxLines);
}

export interface ChunkFileOptions extends ChunkOptions {
  workspaceId?: string;
}

/** Chunk a file into the stored `CodeChunk` shape. */
export function chunkFile(relativePath: string, absolutePath: string, content: string, options: ChunkFileOptions = {}): CodeChunk[] {
  const language = languageForPath(relativePath);
  const prefix = options.workspaceId ? `${options.workspaceId}:${relativePath}` : relativePath;
  // The trailing sequence keeps ids unique even when character windowing emits
  // several chunks for the same (minified) source line.
  return chunkText(content, options).map((span, index) => ({
    id: `${prefix}:${span.startLine}:${index}`,
    relativePath,
    absolutePath,
    startLine: span.startLine,
    endLine: span.endLine,
    language,
    content: span.content,
    tokenEstimate: span.tokenEstimate,
  }));
}
