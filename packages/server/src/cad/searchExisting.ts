import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CadProgressEvent, WebSearchResponse, WebSearchResult } from "@forge/shared";
import { runWebSearch } from "../tools/webSearch";
import { loadWebSearchConfig } from "../config";
import { validateModelFile } from "./modelValidate";
import { convertStepToGlb } from "./convertToGlb";
import type { CadConfig } from "./config";

/**
 * Search-first path: if a real manufactured part is being asked for, the real
 * CAD file beats anything a model can invent.
 *
 * An Arduino Uno carries silkscreen, exact connector placements and PCB
 * artwork; a generated approximation of it is a *worse* answer than the
 * manufacturer's own STEP, so the pipeline tries this path before MAC and uses
 * MAC only when nothing verifiable turns up. The same is true of standard
 * hardware (M8 fasteners, bearings, wheels), which is exactly why
 * McMaster/TraceParts-style catalogues are worth a query.
 *
 * Nothing here is trusted because a search engine said so. Every candidate is
 * downloaded with a byte ceiling, then judged on content — magic bytes, STEP
 * structure, truncation — and finally by a real OpenCascade read (the shared
 * STEP→GLB converter, the same one the generated path uses). A login page
 * saved as `bolt.step` fails the first check; a truncated file fails the
 * second; both are dropped with a reason, and the pipeline falls through.
 */

export interface ExistingModel {
  /** Absolute paths inside Forge's CAD cache. */
  stepPath: string;
  glbPath: string;
  stlPath?: string;
  sourceUrl: string;
  title: string;
  summary: string;
}

export interface SearchAttempt {
  model: ExistingModel | null;
  /** What was tried and why each candidate was rejected — shown in the log. */
  notes: string[];
  /** True when web search itself is unavailable (no key), not merely "nothing found". */
  searchUnavailable: boolean;
}

export interface SearchOptions {
  config: CadConfig;
  artifactDir: string;
  signal?: AbortSignal;
  emit?: (event: CadProgressEvent) => void;
  /** Test seam: replace the HTTP layer entirely. */
  fetchImpl?: typeof fetch;
  /** Cap on candidates actually downloaded (each is a real fetch + OCCT read). */
  maxCandidates?: number;
  /**
   * Test seam for the search backend. Defaults to Prompt 5's `web_search`
   * implementation (`runWebSearch`), so the pipeline never re-implements or
   * bypasses the provider choice Forge already made.
   */
  searchImpl?: (query: string, maxResults: number, signal?: AbortSignal) => Promise<WebSearchResponse>;
}

/** Hosts whose links are worth following first, with a soft reputation weight. */
const HOST_WEIGHTS: [RegExp, number, string][] = [
  [/mcmaster\.com/i, 12, "McMaster-Carr catalogue"],
  [/traceparts\.com/i, 10, "TraceParts catalogue"],
  [/misumi\.com/i, 9, "MiSUMi catalogue"],
  [/(igus|elesa|kipp|norelem|ganter|stauff|dbh-socketing|ringfeder|rollco|thomson-linear|bearingsdirect|rahm|bbox)\b/i, 8, "component manufacturer"],
  [/(3dcontentcentral|mcadcentral|grabcad)\.com/i, 6, "CAD community library"],
  [/a3dmodels\.org/i, 6, "3D model library"],
  [/(githubusercontent\.com|github\.com)/i, 5, "repository-hosted file"],
  [/\.step$|\.stp$/i, 4, "direct STEP link"],
];

const PAGE_FETCH_TIMEOUT_MS = 20_000;

const FILE_URL = /https?:\/\/[^\s"'<>()\]]+\.(?:step|stp|stl)(?:\?[^\s"'<>()\]]*)?/gi;

const weightFor = (url: string): number => {
  let best = 1;
  for (const [pattern, weight] of HOST_WEIGHTS) if (pattern.test(url)) best = Math.max(best, weight);
  return best;
};

/** "a standard M8 hex bolt" → "M8 hex bolt"; "an arduino uno" → "arduino uno". */
export function normalizeObjectName(prompt: string): string {
  let text = prompt.trim().replace(/^["']|["']$/g, "");
  text = text.replace(/^\s*(please|can you|could you|let's|lets)\s+/i, "");
  // `an|a|the` order matters: a bare `a|an` alternative eats the "a" of "an".
  text = text.replace(/^\s*(?:create|design|model|generate|make|build|find|search for)\s+(?:me\s+)?(?:(?:an|a|the)\s+)?/i, "");
  text = text.replace(/\b(a|an|the)\b/gi, " ");
  text = text.replace(/\b(real|actual|standard|simple|basic|typical|generic|3d\s*model|cad\s*model|assembly|object|part)\b/gi, " ");
  text = text.replace(/[.,;:!?]+/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(" ").slice(0, 12);
  return words.join(" ") || prompt.trim().slice(0, 60);
}

/** Deterministic queries: "give me a downloadable file", not "explain this part". */
export function searchQueries(objectName: string): string[] {
  const name = objectName.slice(0, 120);
  return [
    `${name} STEP file download`,
    `${name} .step CAD model direct download`,
    `${name} mcmaster OR traceparts OR misumi step`,
    `${name} step model filetype:step`,
  ];
}

interface Candidate {
  url: string;
  ext: "step" | "stp" | "stl";
  weight: number;
  title: string;
}

function collectCandidates(results: WebSearchResult[], textOf: (result: WebSearchResult) => string): Candidate[] {
  const found = new Map<string, Candidate>();
  const add = (url: string, title: string): void => {
    const clean = url.replace(/[.,)]+$/, "");
    const ext = clean.match(/\.(step|stp|stl)(\?|$)/i)?.[1]?.toLowerCase();
    if (!ext) return;
    if (!/^https?:\/\//i.test(clean)) return;
    const key = clean.toLowerCase();
    const current = found.get(key);
    const candidate: Candidate = { url: clean, ext: ext === "stl" ? "stl" : "step", weight: weightFor(clean), title };
    if (!current || current.weight < candidate.weight) found.set(key, candidate);
  };
  for (const result of results) {
    const haystack = textOf(result);
    for (const match of haystack.match(FILE_URL) ?? []) add(match, result.title);
    add(result.url, result.title);
  }
  return [...found.values()].sort((a, b) => (b.ext === "stl" ? -1 : 1) + (b.weight - a.weight));
}

/** Pull direct model links out of an HTML result page (catalogue index pages). */
function linksFromHtml(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    try {
      const absolute = new URL(raw, baseUrl).toString();
      if (!/^https?:/i.test(absolute)) return;
      if (!/\.(step|stp|stl)(\?|$)/i.test(absolute)) return;
      if (seen.has(absolute)) return;
      seen.add(absolute);
      out.push(absolute);
    } catch {
      /* malformed href — ignore this one link */
    }
  };
  for (const match of html.match(FILE_URL) ?? []) add(match);
  for (const match of html.matchAll(/(?:href|data-(?:url|file|href))\s*=\s*["']([^"']+)["']/gi)) {
    if (/\.(step|stp|stl)(\?|$)/i.test(match[1] ?? "")) add(match[1]!);
  }
  return out;
}

const clip = (value: string, limit = 160): string => {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};

async function download(url: string, target: string, config: CadConfig, signal: AbortSignal | undefined, fetchImpl: typeof fetch):
  Promise<{ ok: true; bytes: number; contentType: string } | { ok: false; error: string }> {
  // A catalogue host that accepts the connection and then stalls must not hold
  // a CAD request open until the job timeout, so the whole transfer is bounded.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("download timed out")), config.downloadTimeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await transfer(url, target, config, fetchImpl, controller.signal);
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function transfer(url: string, target: string, config: CadConfig, fetchImpl: typeof fetch, signal: AbortSignal):
  Promise<{ ok: true; bytes: number; contentType: string } | { ok: false; error: string }> {
  let current = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= 5; hop += 1) {
    let attempt: Response;
    try {
      attempt = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: {
          // Some catalogues 403 the default fetch UA; a plain browser-ish one is
          // all that is asked for. No cookies, no credentials, nothing sent back.
          "user-agent": "Forge-CAD/1.0 (+local CAD model fetch)",
          accept: "application/octet-stream, model/step, */*",
        },
      });
    } catch (error) {
      return { ok: false, error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const location = attempt.headers.get("location");
    if (attempt.status >= 300 && attempt.status < 400 && location) {
      await attempt.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }
    response = attempt;
    break;
  }
  if (!response) return { ok: false, error: "gave up after 5 redirect hops (a download endpoint that loops is not a model)" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, error: `HTTP ${response.status}` };
  }
  if (!response.body) return { ok: false, error: "empty response body" };
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > config.maxDownloadBytes) {
    await response.body.cancel().catch(() => undefined);
    return { ok: false, error: `declared size ${declared} bytes exceeds the ${config.maxDownloadBytes} byte ceiling` };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > config.maxDownloadBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: `exceeded the ${config.maxDownloadBytes} byte download ceiling` };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, error: `stream ended early: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (received === 0) return { ok: false, error: "server sent 0 bytes" };
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, body);
  return { ok: true, bytes: received, contentType };
}

async function fetchPage(url: string, maxBytes: number, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("page fetch timed out")), PAGE_FETCH_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": "Forge-CAD/1.0" } });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
    const text = await response.text();
    return text.slice(0, maxBytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Try to find and verify an existing model. `model: null` is the *expected*
 * answer for anything that is not a real catalogue part ("a wristwatch" has no
 * canonical file), and is not an error — the pipeline simply generates instead.
 */
export async function findExistingModel(prompt: string, options: SearchOptions): Promise<SearchAttempt> {
  const { config, artifactDir, signal } = options;
  const notes: string[] = [];
  const emit = (detail: string): void => options.emit?.({ stage: "searching_existing", detail });
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!config.searchEnabled) {
    return { model: null, notes: ["CAD search is disabled (FORGE_CAD_SEARCH=false) — going straight to generation."], searchUnavailable: false };
  }
  const objectName = normalizeObjectName(prompt);
  if (!objectName) return { model: null, notes: ["empty object name — nothing to search for"], searchUnavailable: false };

  const webConfig = loadWebSearchConfig();
  const search = options.searchImpl ?? ((query: string, maxResults: number, signal?: AbortSignal) =>
    runWebSearch(query, maxResults, webConfig, signal));
  if (!options.searchImpl && !webConfig.tavilyApiKey && !webConfig.braveApiKey) {
    const note = "no web-search provider configured (set TAVILY_API_KEY or BRAVE_API_KEY) — skipping the search-first path.";
    emit(note);
    return { model: null, notes: [note], searchUnavailable: true };
  }

  emit(`searching for an existing "${objectName}" STEP/STL file`);
  const results: WebSearchResult[] = [];
  const failures: string[] = [];
  for (const query of searchQueries(objectName)) {
    if (signal?.aborted) break;
    try {
      const response = await search(query, config.searchMaxResults, signal);
      results.push(...response.results);
      if (response.answer) notes.push(`${response.provider} answer: ${clip(response.answer, 220)}`);
      if (results.length >= config.searchMaxResults * 2) break;
    } catch (error) {
      failures.push(`"${clip(query, 60)}" → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length && !results.length) {
    const note = `web search failed: ${failures.join("; ")}`;
    emit(note);
    return { model: null, notes: [note], searchUnavailable: true };
  }
  emit(`${results.length} search result(s) across ${searchQueries(objectName).length - (failures.length ? 1 : 0)} query(ies)`);

  const uniqueResults = [...new Map(results.map((result) => [result.url.toLowerCase(), result])).values()];
  let candidates = collectCandidates(uniqueResults, (result) => `${result.title}\n${result.url}\n${result.snippet}`);
  notes.push(`${candidates.length} direct model link(s) in search results`);

  // No direct file in the results themselves: open the most promising result
  // pages and look for file links in their markup.
  if (candidates.length === 0) {
    const pages = uniqueResults.filter((result) => /step|stp|cad|3d|model|download/i.test(`${result.title} ${result.url}`)).slice(0, 3);
    for (const page of pages) {
      if (signal?.aborted) break;
      const html = await fetchPage(page.url, 300_000, signal, fetchImpl);
      if (!html) { notes.push(`could not read ${clip(page.url, 90)} (blocked, offline, or not HTML)`); continue; }
      const links = linksFromHtml(html, page.url);
      if (!links.length) { notes.push(`no direct STEP/STL link on ${clip(page.url, 90)} (catalogue pages gate downloads behind a form/login)`); continue; }
      candidates.push(...links.map((link) => ({
        url: link, ext: /\.stl(\?|$)/i.test(link) ? "stl" as const : "step" as const,
        weight: weightFor(link) + 1, title: page.title,
      })));
    }
    candidates = candidates.sort((a, b) => (b.ext === "stl" ? -1 : 1) + (b.weight - a.weight));
  }

  if (!candidates.length) {
    const note = `no downloadable STEP/STL candidate for "${objectName}" — a generic description like this usually has no single canonical file`;
    emit(note);
    return { model: null, notes: [...notes, note], searchUnavailable: false };
  }

  const maxCandidates = options.maxCandidates ?? 4;
  for (const [index, candidate] of candidates.slice(0, maxCandidates).entries()) {
    if (signal?.aborted) break;
    if (candidate.ext === "stl") {
      // An STL is only a tessellated skin: no units, no B-rep, and nothing a
      // STEP-consuming CAD workflow can use. Skip before fetching it.
      notes.push(`skipped ${clip(candidate.url, 90)}: STL only (no STEP) — Forge needs the B-rep file to preview and to hand back for CAD use`);
      emit(`skipped ${clip(candidate.url, 90)}: STL only, no STEP file`);
      continue;
    }
    const target = join(artifactDir, `download-${index + 1}.step`);
    emit(`trying ${clip(candidate.url, 110)} (${candidate.title ? clip(candidate.title, 50) : "untitled"})`);
    const downloaded = await download(candidate.url, target, config, signal, fetchImpl);
    if (!downloaded.ok) {
      notes.push(`rejected ${clip(candidate.url, 90)}: ${downloaded.error}`);
      emit(`rejected ${clip(candidate.url, 90)}: ${downloaded.error}`);
      continue;
    }
    const validated = await validateModelFile(target, "step");
    if (!validated.ok) {
      notes.push(`rejected ${clip(candidate.url, 90)}: ${validated.reason}`);
      emit(`rejected ${clip(candidate.url, 90)}: ${validated.reason}`);
      continue;
    }
    // The real OCCT read: the shared STEP→GLB converter either parses it or does
    // not. A corrupt/truncated file cannot survive this, so a returned model is
    // always one a geometry kernel actually opened.
    const conversion = await convertStepToGlb(target, artifactDir, config, { name: `download-${index + 1}`, signal });
    if (!conversion.ok || !conversion.glbPath) {
      notes.push(`rejected ${clip(candidate.url, 90)}: OpenCASCADE could not read it (${conversion.error ?? "no GLB produced"})`);
      emit(`rejected ${clip(candidate.url, 90)}: ${conversion.detail}`);
      continue;
    }
    const finalStep = join(artifactDir, "model.step");
    await mkdir(artifactDir, { recursive: true });
    if (target !== finalStep) await rename(target, finalStep);
    const finalGlb = join(artifactDir, "model.glb");
    if (conversion.glbPath !== finalGlb) await rename(conversion.glbPath, finalGlb).catch(() => undefined);
    const glbPath = (await stat(finalGlb).catch(() => null)) ? finalGlb : conversion.glbPath;
    emit(`verified STEP from ${clip(candidate.url, 90)} — ${validated.fingerprint.summary}`);
    return {
      model: {
        stepPath: finalStep, glbPath, sourceUrl: candidate.url,
        title: candidate.title || candidate.url,
        summary: `${validated.fingerprint.summary}; read by OpenCASCADE for the preview`,
      },
      notes,
      searchUnavailable: false,
    };
  }
  const note = `every candidate for "${objectName}" failed validation — generating with MAC instead`;
  emit(note);
  return { model: null, notes: [...notes, note], searchUnavailable: false };
}

