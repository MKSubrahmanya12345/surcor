import type { ReactNode } from "react";

/**
 * Minimal safe markdown renderer for chat messages. Produces React nodes
 * (never raw HTML), so model output cannot inject markup. Supports fenced
 * code blocks, headings, ordered/unordered lists, inline code, bold,
 * italics, and links.
 */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;
    if (token.startsWith("`")) {
      nodes.push(<code key={key} className="md-inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = LINK.exec(token);
      if (link) {
        const href = link[2];
        nodes.push(
          <a
            key={key}
            className="md-link"
            href={href}
            onClick={(event) => {
              // Never navigate the app window; Electron routes window.open
              // through setWindowOpenHandler -> shell.openExternal.
              event.preventDefault();
              window.open(href, "_blank");
            }}
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function renderMarkdown(source: string): ReactNode {
  if (!source.trim()) return null;
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let counter = 0;
  const nextKey = (): string => {
    counter += 1;
    return `md-${counter}`;
  };
  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push(<p key={nextKey()}>{parseInline(paragraph.join(" "), `p${counter}`)}</p>);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const items = list.items.map((item, itemIndex) => (
      <li key={itemIndex}>{parseInline(item, `li${counter}-${itemIndex}`)}</li>
    ));
    blocks.push(list.ordered ? <ol key={nextKey()}>{items}</ol> : <ul key={nextKey()}>{items}</ul>);
    list = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushList();
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or past the end of unterminated blocks)
      blocks.push(<pre key={nextKey()}><code>{buffer.join("\n")}</code></pre>);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 4);
      const body = parseInline(heading[2], `h${counter}`);
      if (level === 1) blocks.push(<h1 key={nextKey()}>{body}</h1>);
      else if (level === 2) blocks.push(<h2 key={nextKey()}>{body}</h2>);
      else if (level === 3) blocks.push(<h3 key={nextKey()}>{body}</h3>);
      else blocks.push(<h4 key={nextKey()}>{body}</h4>);
      i += 1;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ordered || unordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const itemText = (ordered ?? unordered)?.[1] ?? "";
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(itemText);
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  flushList();

  return <div className="markdown">{blocks}</div>;
}
