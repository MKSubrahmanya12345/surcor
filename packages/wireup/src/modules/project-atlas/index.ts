/**
 * Project Atlas — deterministic source → graph → quantified transformation.
 *
 * This is the substrate, not a claim that a particular frontier model is
 * installed. The model seam can later enrich extraction, while the persisted
 * representation, provenance, confidence and approval boundary stay stable.
 *
 * Pipeline:
 *
 *   clone source → split text units → extract facts/requirements/metrics
 *   → connect a provenance graph → quantify coverage → propose target files
 *   → wait for human approval
 */

import { createHash } from 'node:crypto';

import type {
  AtlasEdge,
  AtlasEdgeKind,
  AtlasGeneratedFile,
  AtlasMapping,
  AtlasMetric,
  AtlasNode,
  AtlasNodeKind,
  AtlasSource,
  AtlasSourceKind,
  AtlasTargetSpec,
  AtlasTransformPlan,
  ProjectAtlasState,
} from '@/types/project-atlas';
import { nowIso } from '@/lib/validation/time';
import { shortHash, slug } from '@/modules/graph';

export interface AtlasSourceInput {
  title?: string;
  kind?: AtlasSourceKind;
  content: string;
  origin?: AtlasSource['origin'];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const DOMAIN_TERMS: { label: string; pattern: RegExp; kind: AtlasNodeKind; tags: string[] }[] = [
  { label: 'guitar', pattern: /\bguitars?\b/i, kind: 'entity', tags: ['music', 'instrument'] },
  { label: 'bass guitar', pattern: /\bbass(?:\s+guitar)?s?\b/i, kind: 'entity', tags: ['music', 'instrument'] },
  { label: 'body', pattern: /\bbody\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'neck', pattern: /\bneck\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'fretboard', pattern: /\bfretboard|fingerboard\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'pickup', pattern: /\bpickups?\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'bridge', pattern: /\bbridge\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'tuning', pattern: /\btuning\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'strings', pattern: /\bstrings?\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'scale length', pattern: /\bscale\s+length\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'finish', pattern: /\bfinish\b/i, kind: 'concept', tags: ['instrument', 'profile-field'] },
  { label: 'manufacturer', pattern: /\bmanufacturer|maker|brand\b/i, kind: 'concept', tags: ['profile-field'] },
  { label: 'model', pattern: /\bmodel\b/i, kind: 'concept', tags: ['profile-field'] },
  { label: 'sensor', pattern: /\bsensors?\b/i, kind: 'entity', tags: ['hardware'] },
  { label: 'motor', pattern: /\bmotors?\b/i, kind: 'entity', tags: ['hardware'] },
  { label: 'api', pattern: /\bapis?\b/i, kind: 'concept', tags: ['software'] },
  { label: 'database', pattern: /\bdatabases?\b/i, kind: 'concept', tags: ['software'] },
  { label: 'user', pattern: /\busers?\b/i, kind: 'entity', tags: ['software'] },
  { label: 'profile', pattern: /\bprofiles?\b/i, kind: 'concept', tags: ['software', 'data'] },
];

const PROFILE_FIELD_LABELS = new Set([
  'body',
  'neck',
  'fretboard',
  'pickup',
  'bridge',
  'tuning',
  'strings',
  'scale length',
  'finish',
  'manufacturer',
  'model',
  'weight',
  'frets',
  'wood',
  'color',
  'colour',
]);

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function contentHash(content: string): string {
  // Content addressing makes a cloned source auditable and lets a later model
  // run prove whether it actually read the same bytes.
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function sourceId(input: AtlasSourceInput): string {
  return `atlas-source-${shortHash(`${input.title ?? 'source'}:${input.content}`)}`;
}

export function normalizeAtlasSource(input: AtlasSourceInput): AtlasSource {
  const content = input.content.trim();
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  return {
    id: sourceId(input),
    kind: input.kind ?? 'profile',
    origin: input.origin ?? 'user',
    title: (input.title ?? 'Untitled source').trim().slice(0, 160) || 'Untitled source',
    content,
    contentHash: contentHash(content),
    chars: content.length,
    lines,
    capturedAt: nowIso(),
  };
}

function splitText(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
  return paragraphs.length > 0 ? paragraphs : [content.trim()].filter(Boolean);
}

function numberValue(raw: string): number | undefined {
  const token = raw.toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number.parseFloat(token);
  return NUMBER_WORDS[token];
}

function canonicalUnit(raw: string): { unit: string; multiplier: number } {
  const token = raw.toLowerCase();
  if (token === 'cm') return { unit: 'mm', multiplier: 10 };
  if (token === 'in' || token.startsWith('inch')) return { unit: 'in', multiplier: 1 };
  if (token === 'g') return { unit: 'g', multiplier: 1 };
  if (token === 'kg') return { unit: 'kg', multiplier: 1 };
  if (token === 'ma') return { unit: 'mA', multiplier: 1 };
  if (token === 'hz') return { unit: 'Hz', multiplier: 1 };
  if (token === 'v') return { unit: 'V', multiplier: 1 };
  if (token === 'a') return { unit: 'A', multiplier: 1 };
  if (token === '%') return { unit: '%', multiplier: 1 };
  if (/string|pickup|fret/.test(token)) return { unit: 'count', multiplier: 1 };
  return { unit: 'count', multiplier: 1 };
}

function fieldName(value: string): string {
  const words = normalized(value).split(' ').filter(Boolean);
  if (words.length === 0) return 'sourceValue';
  return words
    .map((word, index) => index === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
    .replace(/\s/g, '')
    .replace(/^[0-9]+/, '')
    .replace(/^class$/, 'className') || 'sourceValue';
}

function javaClassName(value: string): string {
  const words = normalized(value).split(' ').filter(Boolean);
  const name = words.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join('');
  return /^[A-Za-z]/.test(name) ? name : `Generated${name}`;
}

function javaType(unit?: string, value?: string | number): string {
  if (unit === 'count') return 'int';
  if (unit && ['mm', 'in', 'kg', 'g', 'mA', 'Hz', 'V', 'A', '%'].includes(unit)) return 'double';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  return 'String';
}

function javaDefault(type: string, name: string, sourceLabel?: string): string {
  const key = normalized(sourceLabel ?? name).replace(/\s+/g, '-');
  if (type === 'String') return `value(values, "${key}")`;
  if (type === 'int') return `parseInt(value(values, "${key}"))`;
  return `parseDouble(value(values, "${key}"))`;
}

function safePackage(value: string | undefined): string {
  const candidate = (value ?? 'generated').toLowerCase().replace(/[^a-z0-9.]+/g, '.').replace(/^\.+|\.+$/g, '');
  return candidate || 'generated';
}

function sentenceNeedsReview(sentence: string): boolean {
  return /\?|\b(unknown|tbd|todo|unspecified|unclear|not sure|verify|check with|may fail)\b/i.test(sentence);
}

function edgeKey(from: string, kind: AtlasEdgeKind, to: string): string {
  return `${from}|${kind}|${to}`;
}

export function buildProjectAtlas(inputs: AtlasSourceInput[] | AtlasSource[], version = 1): ProjectAtlasState {
  const sources = inputs.map((input) => 'contentHash' in input ? input : normalizeAtlasSource(input));
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const metrics: AtlasMetric[] = [];
  const nodeByKey = new Map<string, AtlasNode>();
  const edgeKeys = new Set<string>();

  const addNode = (candidate: AtlasNode): AtlasNode => {
    const key = `${candidate.kind}:${normalized(candidate.label)}`;
    const existing = nodeByKey.get(key);
    if (existing) {
      existing.sourceIds = [...new Set([...existing.sourceIds, ...candidate.sourceIds])];
      existing.tags = [...new Set([...existing.tags, ...candidate.tags])];
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      if (existing.status === 'unresolved' && candidate.status !== 'unresolved') existing.status = candidate.status;
      if (existing.value === undefined && candidate.value !== undefined) existing.value = candidate.value;
      if (existing.unit === undefined && candidate.unit !== undefined) existing.unit = candidate.unit;
      if (existing.quantity === undefined && candidate.quantity !== undefined) existing.quantity = candidate.quantity;
      return existing;
    }
    nodeByKey.set(key, candidate);
    nodes.push(candidate);
    return candidate;
  };

  const addEdge = (from: AtlasNode | string, to: AtlasNode | string, kind: AtlasEdgeKind, sourceIds: string[], confidence: number, evidence?: string): void => {
    const fromId = typeof from === 'string' ? from : from.id;
    const toId = typeof to === 'string' ? to : to.id;
    if (fromId === toId || !fromId || !toId) return;
    const key = edgeKey(fromId, kind, toId);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: `atlas-edge-${shortHash(key)}`,
      from: fromId,
      to: toId,
      kind,
      weight: 1,
      confidence: clamp(confidence),
      sourceIds: [...new Set(sourceIds)],
      ...(evidence ? { evidence: evidence.slice(0, 220) } : {}),
    });
  };

  for (const source of sources) {
    const sourceNode = addNode({
      id: `atlas-node-source-${slug(source.id)}`,
      kind: 'source',
      label: source.title,
      description: `${source.kind} source · ${source.chars} characters · ${source.lines} lines`,
      confidence: 1,
      status: 'observed',
      sourceIds: [source.id],
      tags: [source.kind, source.origin],
    });
    const textUnits = splitText(source.content);
    const sourceFacts: AtlasNode[] = [];

    textUnits.forEach((text, index) => {
      const textNode = addNode({
        id: `atlas-node-text-${slug(source.id)}-${index + 1}`,
        kind: 'text_unit',
        label: `Source passage ${index + 1}`,
        description: text,
        confidence: 1,
        status: 'observed',
        sourceIds: [source.id],
        tags: ['text-unit'],
      });
      addEdge(sourceNode, textNode, 'contains', [source.id], 1, source.title);

      const termsInPassage = DOMAIN_TERMS.filter((term) => term.pattern.test(text));
      for (const term of termsInPassage) {
        const concept = addNode({
          id: `atlas-node-${term.kind}-${slug(term.label)}`,
          kind: term.kind,
          label: term.label,
          description: `Observed in ${source.title}.`,
          confidence: 0.94,
          status: 'observed',
          sourceIds: [source.id],
          tags: term.tags,
        });
        sourceFacts.push(concept);
        addEdge(textNode, concept, 'mentions', [source.id], 0.94, text);
      }

      if (/\b(must|should|need(?:s)?|require(?:s)?|want(?:s)?|convert|build|support|target|preserve)\b/i.test(text)) {
        const requirement = addNode({
          id: `atlas-node-requirement-${shortHash(`${source.id}:${text}`)}`,
          kind: 'requirement',
          label: text.length > 76 ? `${text.slice(0, 73)}…` : text,
          description: text,
          confidence: 0.86,
          status: 'inferred',
          sourceIds: [source.id],
          tags: ['claim', 'requirement'],
        });
        sourceFacts.push(requirement);
        addEdge(textNode, requirement, 'supports', [source.id], 0.86, text);
        for (const fact of sourceFacts.filter((candidate) => candidate !== requirement && candidate.kind !== 'text_unit')) {
          addEdge(requirement, fact, 'requires', [source.id], 0.72, text);
        }
      }

      if (sentenceNeedsReview(text)) {
        const risk = addNode({
          id: `atlas-node-risk-${shortHash(`${source.id}:${text}`)}`,
          kind: 'risk',
          label: text.length > 70 ? `${text.slice(0, 67)}…` : text,
          description: text,
          confidence: 0.42,
          status: 'unresolved',
          sourceIds: [source.id],
          tags: ['needs-human-review'],
        });
        sourceFacts.push(risk);
        addEdge(textNode, risk, 'supports', [source.id], 0.8, text);
      }
    });

    // Structured profile lines are first-class facts, not just raw text.
    const fieldPattern = /^\s*([A-Za-z][A-Za-z0-9 /_-]{1,42})\s*[:=]\s*(.+?)\s*$/gm;
    const structuredRanges: { start: number; end: number }[] = [];
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldPattern.exec(source.content)) !== null) {
      structuredRanges.push({ start: fieldMatch.index, end: fieldMatch.index + fieldMatch[0].length });
      const label = (fieldMatch[1] ?? '').trim();
      const rawValue = (fieldMatch[2] ?? '').trim();
      const fieldKey = normalized(label);
      if (!fieldKey || rawValue.length === 0) continue;
      const knownField = PROFILE_FIELD_LABELS.has(fieldKey) || fieldKey.length <= 24;
      if (!knownField) continue;
      const metricMatch = /^(\d+(?:\.\d+)?)\s*(mm|cm|in|inches?|kg|g|hz|v|a|ma|%|strings?|pickups?|frets?)?$/i.exec(rawValue);
      const metric = metricMatch ? (() => {
        const rawNumber = Number.parseFloat(metricMatch[1] ?? '0');
        const converted = canonicalUnit(metricMatch[2] ?? 'count');
        return { value: rawNumber * converted.multiplier, unit: converted.unit };
      })() : null;
      const fact = addNode({
        id: `atlas-node-concept-${slug(fieldKey)}`,
        kind: metric ? 'metric' : 'concept',
        label,
        description: rawValue,
        ...(metric ? { value: metric.value, unit: metric.unit } : { value: rawValue }),
        confidence: 0.97,
        status: 'observed',
        sourceIds: [source.id],
        tags: ['structured-field', ...(PROFILE_FIELD_LABELS.has(fieldKey) ? ['profile-field'] : [])],
      });
      addEdge(`atlas-node-source-${slug(source.id)}`, fact, metric ? 'measures' : 'mentions', [source.id], 0.97, `${label}: ${rawValue}`);
      if (metric) {
        const metricRecord: AtlasMetric = {
          id: `atlas-metric-${slug(fieldKey)}`,
          label,
          value: metric.value,
          unit: metric.unit,
          status: 'measured',
          sourceIds: [source.id],
        };
        if (!metrics.some((entry) => entry.id === metricRecord.id)) metrics.push(metricRecord);
      }
    }

    // Free-form quantities and measurements. Keep the context in the label so
    // a number is never detached from the thing it measures.
    const measurement = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(mm|cm|in|inches?|kg|g|hz|v|a|ma|%|strings?|pickups?|frets?)\b/gi;
    let measurementMatch: RegExpExecArray | null;
    while ((measurementMatch = measurement.exec(source.content)) !== null) {
      if (structuredRanges.some((range) => measurementMatch!.index >= range.start && measurementMatch!.index < range.end)) continue;
      const rawNumber = numberValue(measurementMatch[1] ?? '');
      if (rawNumber === undefined) continue;
      const converted = canonicalUnit(measurementMatch[2] ?? 'count');
      const before = source.content.slice(Math.max(0, measurementMatch.index - 42), measurementMatch.index).replace(/\s+/g, ' ').trim();
      const contextWords = before.split(' ').slice(-4).join(' ');
      const rawUnit = (measurementMatch[2] ?? '').toLowerCase();
      const label = /strings?|pickups?|frets?/.test(rawUnit) ? rawUnit : contextWords || rawUnit || 'measurement';
      const metricId = `atlas-metric-${slug(label)}-${converted.unit}`;
      if (!metrics.some((entry) => entry.id === metricId)) {
        metrics.push({
          id: metricId,
          label,
          value: rawNumber * converted.multiplier,
          unit: converted.unit,
          status: 'measured',
          sourceIds: [source.id],
        });
      }
    }
  }

  const metricNodesByKey = new Map<string, AtlasNode>();
  for (const metric of metrics) {
    const node = addNode({
      id: `atlas-node-metric-${slug(metric.id)}`,
      kind: 'metric',
      label: metric.label,
      description: `${metric.value} ${metric.unit}`,
      value: metric.value,
      unit: metric.unit,
      confidence: metric.status === 'measured' ? 0.96 : 0.65,
      status: metric.status === 'measured' ? 'observed' : 'inferred',
      sourceIds: metric.sourceIds,
      tags: ['quantified'],
    });
    metricNodesByKey.set(metric.id, node);
    for (const sourceId of metric.sourceIds) {
      const sourceNode = nodes.find((candidate) => candidate.sourceIds.includes(sourceId) && candidate.kind === 'source');
      if (sourceNode) addEdge(sourceNode, node, 'measures', [sourceId], node.confidence, metric.label);
    }
  }

  // A measured quantity should explain the nearest concept, when the label
  // contains it. This is a small deterministic multi-hop bridge.
  for (const metric of metrics) {
    const metricNode = metricNodesByKey.get(metric.id);
    if (!metricNode) continue;
    const label = normalized(metric.label);
    const concept = nodes.find((candidate) => candidate.kind !== 'source' && candidate.kind !== 'text_unit' && candidate.kind !== 'metric' && (label.includes(normalized(candidate.label)) || normalized(candidate.label).includes(label)));
    if (concept) addEdge(metricNode, concept, 'measures', metric.sourceIds, 0.78, metric.label);
  }

  const sourceChars = sources.reduce((sum, source) => sum + source.chars, 0);
  const sourceLines = sources.reduce((sum, source) => sum + source.lines, 0);
  const textUnitCount = nodes.filter((node) => node.kind === 'text_unit').length;
  const claims = nodes.filter((node) => ['requirement', 'concept', 'entity', 'metric'].includes(node.kind));
  const unresolvedCount = nodes.filter((node) => node.status === 'unresolved').length;
  const resolvedCount = claims.filter((node) => node.status === 'observed' || node.status === 'verified').length;
  const confidence = nodes.length === 0 ? 0 : nodes.reduce((sum, node) => sum + node.confidence, 0) / nodes.length;
  const quantification = {
    sourceChars,
    sourceLines,
    sourceTokensApprox: Math.ceil(sourceChars / 4),
    sourceCount: sources.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    textUnitCount,
    claimCount: claims.length,
    metricCount: metrics.length,
    resolvedCount,
    unresolvedCount,
    riskCount: nodes.filter((node) => node.kind === 'risk').length,
    coverage: claims.length === 0 ? 0 : clamp(resolvedCount / claims.length),
    confidence: clamp(confidence),
  };

  return {
    version,
    sources,
    nodes,
    edges,
    metrics,
    quantification,
    transform: null,
    updatedAt: nowIso(),
  };
}

function sourceText(atlas: ProjectAtlasState): string {
  return atlas.sources.map((source) => `${source.title}\n${source.content}`).join('\n\n');
}

function isGuitarDomain(atlas: ProjectAtlasState): boolean {
  return /\b(guitar|bass|pickup|fretboard|six[-\s]?string)\b/i.test(sourceText(atlas));
}

function fieldCandidates(atlas: ProjectAtlasState): { node: AtlasNode; name: string; type: string }[] {
  const result: { node: AtlasNode; name: string; type: string }[] = [];
  const taken = new Set<string>();
  const structuredLabels = new Set(atlas.nodes.filter((node) => node.tags.includes('structured-field')).map((node) => normalized(node.label)));
  const candidates = [...atlas.nodes].sort((a, b) => {
    const weight = (node: AtlasNode): number => node.tags.includes('structured-field') ? -2 : node.kind === 'metric' ? -1 : 0;
    return weight(a) - weight(b);
  });
  for (const node of candidates) {
    if (node.kind !== 'concept' && node.kind !== 'metric') continue;
    const key = normalized(node.label);
    const hasStructuredAlias = !node.tags.includes('structured-field') && (structuredLabels.has(`${key}s`) || (key.endsWith('s') && structuredLabels.has(key.slice(0, -1))));
    if (hasStructuredAlias) continue;
    const isField = node.tags.includes('structured-field') || node.tags.includes('profile-field') || PROFILE_FIELD_LABELS.has(key) || node.kind === 'metric';
    if (!isField) continue;
    const name = fieldName(node.label);
    if (taken.has(name) || ['sourceValue', 'guitar', 'profile'].includes(name)) continue;
    taken.add(name);
    result.push({ node, name, type: javaType(node.unit, node.value) });
  }
  return result.slice(0, 18);
}

function renderJavaModel(className: string, packageName: string, fields: { node: AtlasNode; name: string; type: string }[], atlas: ProjectAtlasState): string {
  const declarations = fields.map((field) => `    ${field.type} ${field.name}`).join(',\n');
  const comments = fields.map((field) => ` * ${field.name}: ${field.node.description} [confidence ${(field.node.confidence * 100).toFixed(0)}%]`).join('\n');
  return `package ${packageName};\n\n/**\n * Generated from Project Atlas snapshot v${atlas.version}.\n * This file is a typed projection, not a silent rewrite of the source.\n${comments}\n */\npublic record ${className}(\n${declarations}\n) {\n}\n`;
}

function renderJavaParser(className: string, packageName: string, fields: { node: AtlasNode; name: string; type: string }[]): string {
  const args = fields.map((field) => `      ${javaDefault(field.type, field.name, field.node.label)}`).join(',\n');
  return `package ${packageName};\n\nimport java.util.LinkedHashMap;\nimport java.util.Map;\n\n/** Reads a simple key: value profile into the generated typed model. */\npublic final class ${className}Parser {\n  private ${className}Parser() {}\n\n  public static ${className} parse(String text) {\n    Map<String, String> values = readKeyValues(text);\n    return new ${className}(\n${args}\n    );\n  }\n\n  public static Map<String, String> readKeyValues(String text) {\n    Map<String, String> values = new LinkedHashMap<>();\n    for (String line : text.split("\\\\R")) {\n      int separator = line.indexOf(':');\n      if (separator > 0) {\n        String key = line.substring(0, separator).trim().toLowerCase().replace(' ', '-');\n        values.put(key, line.substring(separator + 1).trim());\n      }\n    }\n    return values;\n  }\n\n  private static String value(Map<String, String> values, String key) {\n    return values.get(key.toLowerCase().replace(' ', '-'));\n  }\n\n  private static int parseInt(String value) {\n    try { return value == null ? 0 : Integer.parseInt(value.replaceAll("[^0-9-]", "")); }\n    catch (NumberFormatException ignored) { return 0; }\n  }\n\n  private static double parseDouble(String value) {\n    try { return value == null ? 0.0 : Double.parseDouble(value.replaceAll("[^0-9.\\\\-]", "")); }\n    catch (NumberFormatException ignored) { return 0.0; }\n  }\n}\n`;
}

function renderJavaTest(className: string, packageName: string, fields: { node: AtlasNode; name: string; type: string }[]): string {
  const checks = fields.slice(0, 3).map((field) =>
    field.type === 'String'
      ? `    // Atlas mapping: ${field.name} ← ${field.node.label}\n    if (model.${field.name}() == null) throw new AssertionError("${field.name} was not mapped");`
      : `    // Atlas mapping: ${field.name} ← ${field.node.label} (numeric default is deterministic when absent)`,
  ).join('\n');
  const stringFields = fields.filter((field) => field.type === 'String');
  const seed = stringFields.map((field) => `      "${normalized(field.node.label)}: sample"`).join(' + "\\n" +\n') || '      "profile: sample"';
  return `package ${packageName};\n\n/** Dependency-free smoke test for the generated projection. */\npublic final class ${className}Test {\n  public static void main(String[] args) {\n    ${className} model = ${className}Parser.parse(\n${seed}\n    );\n${checks}\n    System.out.println("Atlas projection OK");\n  }\n}\n`;
}

function renderPom(packageName: string, className: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"\n         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>${packageName}</groupId>\n  <artifactId>${className.toLowerCase()}</artifactId>\n  <version>0.1.0-SNAPSHOT</version>\n  <properties>\n    <maven.compiler.release>17</maven.compiler.release>\n    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n  </properties>\n</project>\n`;
}

function renderReadme(className: string, target: AtlasTargetSpec, atlas: ProjectAtlasState, fields: { node: AtlasNode; name: string; type: string }[], gaps: string[]): string {
  const q = atlas.quantification;
  const mappingLines = fields.length > 0 ? fields.map((field) => `- \`${field.name}\` (${field.type}) ← ${field.node.label} · confidence ${(field.node.confidence * 100).toFixed(0)}%`).join('\n') : '- No typed fields were safe to infer; inspect `atlas/graph.json`.';
  const gapLines = gaps.length > 0 ? gaps.map((gap) => `- ${gap}`).join('\n') : '- None recorded.';
  return `# ${className}\n\nGenerated by Project Atlas. This is a reviewable projection of a source graph, not a claim that unknown facts are known.\n\n## Target\n\n- Language: ${target.language}\n- Package: ${safePackage(target.packageName)}\n- Atlas snapshot: v${atlas.version}\n\n## Quantification\n\n- Source: ${q.sourceChars} chars / ${q.sourceLines} lines / ~${q.sourceTokensApprox} tokens\n- Graph: ${q.nodeCount} nodes / ${q.edgeCount} edges / ${q.textUnitCount} text units\n- Facts: ${q.claimCount} claims / ${q.metricCount} metrics / ${(q.coverage * 100).toFixed(0)}% resolved\n- Confidence: ${(q.confidence * 100).toFixed(0)}%\n\n## Mappings\n\n${mappingLines}\n\n## Gaps requiring a human\n\n${gapLines}\n`;
}

function unsupportedPlan(atlas: ProjectAtlasState, target: AtlasTargetSpec, summary: string, gaps: string[]): AtlasTransformPlan {
  return {
    id: `atlas-transform-${shortHash(`${atlas.version}:${target.language}:${target.framework ?? ''}`)}`,
    status: 'unsupported',
    baseVersion: atlas.version,
    target,
    title: `Target adapter needed for ${target.language}`,
    summary,
    rationale: 'Atlas keeps the source graph even when a target adapter is not installed; it will not fabricate output files.',
    steps: [],
    mappings: [],
    files: [],
    gaps,
    metrics: { inputFacts: atlas.quantification.claimCount, mappedFacts: 0, generatedFiles: 0, generatedLines: 0, confidence: 0 },
    requiresApproval: true,
    createdAt: nowIso(),
  };
}

export function planAtlasTransform(atlas: ProjectAtlasState, target: AtlasTargetSpec): AtlasTransformPlan {
  const language = target.language.trim().toLowerCase();
  const canonicalTarget = { ...target, language };
  if (!['java', 'typescript', 'python', 'json-schema'].includes(language)) {
    return unsupportedPlan(atlas, canonicalTarget, `The graph is ready, but no ${language || 'unknown'} adapter is installed yet.`, [`Add a target adapter for ${language || 'the requested language'}.`]);
  }
  if (atlas.sources.length === 0 || atlas.sources.every((source) => source.content.length === 0)) {
    return unsupportedPlan(atlas, canonicalTarget, 'There is no source content to transform.', ['Provide a profile, document, code sample or structured note.']);
  }

  // Java is the first real adapter: it produces a typed record, parser, test
  // and provenance README. Other targets deliberately get an honest roadmap
  // instead of pretending that a Java-shaped output is portable.
  if (language !== 'java') {
    return unsupportedPlan(atlas, canonicalTarget, `${language} is on the adapter roadmap; Java is the first typed projection.`, [`Implement the ${language} emitter against the same Atlas mappings.`]);
  }

  const guitar = isGuitarDomain(atlas);
  const className = javaClassName(guitar ? 'guitar profile' : 'project profile');
  const packageName = safePackage(target.packageName);
  const fields = fieldCandidates(atlas);
  const mappings: AtlasMapping[] = fields.map((field) => ({
    sourceNodeId: field.node.id,
    sourceLabel: field.node.label,
    targetPath: `${className}.${field.name}`,
    targetType: field.type,
    confidence: field.node.confidence,
    reason: field.node.kind === 'metric' ? `Measured ${field.node.value} ${field.node.unit}; emitted as ${field.type}.` : 'Structured profile field observed in the source graph.',
  }));
  const unresolved = atlas.nodes.filter((node) => node.status === 'unresolved').map((node) => node.description).slice(0, 6);
  const gaps = [...unresolved];
  if (fields.length === 0) gaps.push('No safe structured fields were found; the source graph is preserved for a later adapter pass.');
  if (atlas.quantification.coverage < 0.6) gaps.push(`Only ${(atlas.quantification.coverage * 100).toFixed(0)}% of extracted claims are resolved.`);

  const javaRoot = `src/main/java/${packageName.replace(/\./g, '/')}`;
  const testRoot = `src/test/java/${packageName.replace(/\./g, '/')}`;
  const files: AtlasGeneratedFile[] = [
    {
      path: `${javaRoot}/${className}.java`,
      language: 'java',
      purpose: 'Typed record generated from quantified source facts.',
      content: renderJavaModel(className, packageName, fields, atlas),
      sourceNodeIds: mappings.map((mapping) => mapping.sourceNodeId),
    },
    {
      path: `${javaRoot}/${className}Parser.java`,
      language: 'java',
      purpose: 'Deterministic key-value parser for the profile source.',
      content: renderJavaParser(className, packageName, fields),
      sourceNodeIds: atlas.sources.map((source) => `atlas-node-source-${slug(source.id)}`),
    },
    {
      path: `${testRoot}/${className}Test.java`,
      language: 'java',
      purpose: 'Dependency-free smoke test for the generated mapping.',
      content: renderJavaTest(className, packageName, fields),
      sourceNodeIds: mappings.map((mapping) => mapping.sourceNodeId),
    },
    {
      path: 'pom.xml',
      language: 'xml',
      purpose: 'Minimal Java 17 build descriptor for the generated project.',
      content: renderPom(packageName, className),
      sourceNodeIds: [],
    },
    {
      path: 'README.md',
      language: 'markdown',
      purpose: 'Human-readable quantification, mappings, gaps and provenance.',
      content: renderReadme(className, canonicalTarget, atlas, fields, gaps),
      sourceNodeIds: atlas.sources.map((source) => `atlas-node-source-${slug(source.id)}`),
    },
    {
      path: 'atlas/graph.json',
      language: 'json',
      purpose: 'Portable graph, evidence and confidence snapshot.',
      content: JSON.stringify({ version: atlas.version, sources: atlas.sources, nodes: atlas.nodes, edges: atlas.edges, metrics: atlas.metrics, quantification: atlas.quantification }, null, 2),
      sourceNodeIds: atlas.nodes.map((node) => node.id),
    },
  ];
  const generatedLines = files.reduce((sum, file) => sum + file.content.split(/\r?\n/).length, 0);
  const confidence = mappings.length === 0 ? atlas.quantification.confidence : mappings.reduce((sum, mapping) => sum + mapping.confidence, 0) / mappings.length;
  const planId = `atlas-transform-${shortHash(`${atlas.version}:${language}:${className}:${packageName}`)}`;

  return {
    id: planId,
    status: 'ready',
    baseVersion: atlas.version,
    target: canonicalTarget,
    title: `Project Atlas → ${className}`,
    summary: `Map ${mappings.length} quantified fact(s) into a reviewable Java project with ${files.length} files.`,
    rationale: 'The generated project is derived from graph nodes and metrics. Unknowns stay in the README and graph instead of becoming invented fields.',
    steps: [
      { id: 'read', label: 'Read source', detail: `${atlas.quantification.sourceChars} characters cloned into ${atlas.sources.length} source snapshot(s).`, status: 'complete' },
      { id: 'graph', label: 'Build graph', detail: `${atlas.quantification.nodeCount} nodes, ${atlas.quantification.edgeCount} edges and ${atlas.quantification.metricCount} measurable facts.`, status: 'complete' },
      { id: 'map', label: 'Map to Java', detail: `${mappings.length} source fact(s) become typed fields; provenance remains attached.`, status: mappings.length > 0 ? 'ready' : 'needs_review' },
      { id: 'review', label: 'Human review', detail: gaps.length > 0 ? `${gaps.length} gap(s) remain visible before apply.` : 'No unresolved gaps were detected by the deterministic pass.', status: gaps.length > 0 ? 'needs_review' : 'ready' },
    ],
    mappings,
    files,
    gaps,
    metrics: { inputFacts: atlas.quantification.claimCount, mappedFacts: mappings.length, generatedFiles: files.length, generatedLines, confidence: clamp(confidence) },
    requiresApproval: true,
    createdAt: nowIso(),
  };
}

export function withAtlasTransform(atlas: ProjectAtlasState, transform: AtlasTransformPlan): ProjectAtlasState {
  return { ...atlas, transform, updatedAt: nowIso() };
}
