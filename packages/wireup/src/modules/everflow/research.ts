/**
 * Everflow — the agent's research tool (check the docs / the web).
 *
 * The PES brief demands tools for the agent to verify claims against
 * documentation. This module is that tool, with an honesty ladder:
 *
 *   1. the component CATALOG — live ground truth for anything the project
 *      actually selected (highest confidence);
 *   2. the bundled DOCS CORPUS — authored platform/library facts, cited;
 *   3. the live WEB (opt-in via WIREUP_ENABLE_WEB_DOCS) — a snippet pulled
 *      from the cited page, always flagged `needsHumanCheck`.
 *
 * Findings are EVIDENCE with a citation. They inform the graph and the brief;
 * they never satisfy a goal on their own — only passed checks or positive
 * human answers do. When nothing matches, the tool says so and returns null.
 */

import type { ResearchFinding } from '@/types/everflow';
import type { EverflowNode, EverflowGraph } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { env } from '@/lib/validation/env';
import { getSeedComponent } from '@/modules/components/catalog';

import { DOCS_CORPUS, type CorpusEntry } from './docs-corpus';

const WEB_TIMEOUT_MS_FALLBACK = 4000;

function webTimeoutMs(): number {
  try {
    return env().agent.webDocsTimeoutMs ?? WEB_TIMEOUT_MS_FALLBACK;
  } catch {
    return WEB_TIMEOUT_MS_FALLBACK;
  }
}

function webEnabled(): boolean {
  try {
    return env().agent.webDocsEnabled;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Source 1 — the catalog                                                     */
/* -------------------------------------------------------------------------- */

/** Facts straight from the part the project selected, if the node is about one. */
function catalogFacts(state: ProjectState, node: EverflowNode): string[] {
  const text = `${node.label} ${node.content}`.toLowerCase();
  const facts: string[] = [];
  for (const selection of state.components) {
    const name = selection.name.toLowerCase();
    const cid = selection.componentId.toLowerCase();
    if (!text.includes(name) && !text.includes(cid) && !text.includes(selection.componentId.replace(/-/g, ' '))) continue;
    facts.push(`${selection.name}: ${selection.reason ?? 'selected'}.`);
    const definition = getSeedComponent(selection.componentId);
    if (definition?.voltage !== undefined) facts.push(`${selection.name}: nominal ${definition.voltage} V.`);
    if (definition?.communicationProtocols.length) facts.push(`${selection.name}: ${definition.communicationProtocols.slice(0, 4).join(', ')} capable.`);
    if (selection.role) facts.push(`${selection.name} is used as ${selection.role}.`);
    if (selection.quantity > 1) facts.push(`${selection.name}: quantity ${selection.quantity}.`);
  }
  return facts.slice(0, 6);
}

/* -------------------------------------------------------------------------- */
/* Source 2 — the corpus                                                      */
/* -------------------------------------------------------------------------- */

function scoreEntry(entry: CorpusEntry, query: string): number {
  const q = query.toLowerCase();
  let score = 0;
  for (const keyword of entry.keywords) {
    const k = keyword.trim().toLowerCase();
    if (!k) continue;
    if (q.includes(k)) score += k.length > 8 ? 3 : 2;
  }
  // Topic words as a weaker signal.
  for (const word of entry.topic.toLowerCase().split(/\s+/)) {
    if (word.length > 4 && q.includes(word)) score += 1;
  }
  return score;
}

export function matchCorpus(query: string): CorpusEntry | null {
  let best: CorpusEntry | null = null;
  let bestScore = 0;
  for (const entry of DOCS_CORPUS) {
    const score = scoreEntry(entry, query);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

/* -------------------------------------------------------------------------- */
/* Source 3 — the live web (best effort, always flagged)                       */
/* -------------------------------------------------------------------------- */

function extractSnippet(html: string, query: string, maxFacts = 3): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  const sentences = text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 25);
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
  const scored: { sentence: string; score: number }[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let score = 0;
    for (const word of words) if (lower.includes(word)) score += 1;
    if (score > 0) scored.push({ sentence, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFacts).map((entry) => {
    const sentence = entry.sentence;
    return sentence.slice(0, 260) + (sentence.length > 260 ? '…' : '');
  });
}

async function webFacts(entry: CorpusEntry, query: string): Promise<string[] | null> {
  if (!webEnabled()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), webTimeoutMs());
    const response = await fetch(entry.source.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Wireup research tool)', accept: 'text/html' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const html = await response.text();
    const facts = extractSnippet(html, query);
    return facts.length > 0 ? facts : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The tool itself                                                            */
/* -------------------------------------------------------------------------- */

export interface ResearchInput {
  state: ProjectState;
  node: EverflowNode;
  /** Force a live web pull even when the corpus answered (adds a snippet). */
  useWeb?: boolean;
}

/**
 * Check the documentation for one graph node. Returns null when no source
 * matches — the tool never invents facts.
 */
export async function researchNode(input: ResearchInput): Promise<ResearchFinding | null> {
  const { state, node } = input;
  const question = node.content.length > 200 ? `${node.content.slice(0, 200)}…` : node.content;

  const catalog = catalogFacts(state, node);
  const corpus = matchCorpus(`${node.label} ${node.content}`);

  if (catalog.length === 0 && !corpus) return null;

  const facts = [...catalog];
  let source: ResearchFinding['source'] = catalog.length > 0 ? 'catalog' : 'corpus';
  let confidence = catalog.length > 0 ? 0.9 : 0.8;
  let title = 'Component catalog (project record)';
  let url: string | null = null;
  let needsHumanCheck = false;

  if (corpus) {
    facts.push(...corpus.facts.slice(0, 4));
    title = corpus.source.label;
    url = corpus.source.url;
    if (source === 'corpus') {
      source = 'corpus';
      confidence = 0.8;
    }
  }

  const wantWeb = input.useWeb === true || (!catalog.length && !corpus);
  if (wantWeb && corpus) {
    const snippet = await webFacts(corpus, question);
    if (snippet) {
      facts.push(...snippet.map((fact) => `From the web: ${fact}`));
      source = 'web';
      confidence = Math.min(confidence, 0.6);
      needsHumanCheck = true;
    }
  }

  if (facts.length === 0) return null;

  return {
    id: createId('res'),
    nodeId: node.id,
    question,
    source,
    title,
    url,
    facts: facts.slice(0, 10),
    confidence,
    needsHumanCheck,
    at: nowIso(),
  };
}

/* -------------------------------------------------------------------------- */
/* Automatic pass integration                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the agent checks on its own, each pass: low-confidence claims and
 * decisions that no research has touched yet. Offline sources only — the
 * live web stays a deliberate, human-triggered act (or an explicit flag).
 */
export function planAutoResearch(state: ProjectState, graph: EverflowGraph, maxPerPass = 2): { nodeId: string; node: EverflowNode }[] {
  const researched = new Set(state.research.map((finding) => finding.nodeId));
  const picks: { nodeId: string; node: EverflowNode }[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'claim' && node.kind !== 'decision') continue;
    if (node.confidence !== null && node.confidence >= 0.9) continue;
    if (researched.has(node.id)) continue;
    picks.push({ nodeId: node.id, node });
    if (picks.length >= maxPerPass) break;
  }
  return picks;
}
