/**
 * The production ExpansionModel: wires the idea-graph moves to Bedrock.
 *
 * Kept in its own module so the pure decomposition logic (and every verify
 * script importing it) never pulls the AWS SDK in unless a model is actually
 * configured. Every failure mode degrades honestly: the move reports WHY it
 * fell back and the deterministic children carry the graph anyway.
 */

import { env } from '@/lib/validation/env';
import { describeBedrockConfig } from '@/lib/bedrock/client';
import { proposeDecisionPower, proposeExpansion } from '@/lib/bedrock/operations';
import { detectModelFamily } from '@/lib/models';

import type { SubsystemClass, TestRung } from '@/types/everflow';
import type { ExpansionModel, ProposedChild } from './decompose';

const RUNGS: TestRung[] = ['catalog', 'electrical', 'compile', 'behavioral', 'rooting', 'human_verify'];
const CLASSES: SubsystemClass[] = ['POWER', 'DRIVE', 'STEERING', 'CONTROL_LINK', 'SENSING', 'BRAIN', 'STRUCTURE', 'SAFETY', 'OUTPUT', 'OTHER'];

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normaliseChild(raw: unknown): ProposedChild | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const label = asString(record.label, 40);
  if (!label) return null;
  const test = (record.test ?? {}) as Record<string, unknown>;
  const rung = RUNGS.includes(test.rung as TestRung) ? (test.rung as TestRung) : 'catalog';
  const subsystemClass = CLASSES.includes(record.subsystemClass as SubsystemClass) ? (record.subsystemClass as SubsystemClass) : 'OTHER';
  return {
    label,
    content: asString(record.content, 300) || label,
    goalCriterion: asString(record.goal, 300) || `Concrete, testable: ${label}.`,
    subsystemClass,
    stakes: record.stakes === 'risk_gated' ? 'risk_gated' : 'normal',
    testSpec: { rung, assertion: asString(test.assertion, 300) || `${label} is verifiable at the ${rung} rung.` },
  };
}

/**
 * True when any transport can serve the configured expansion model id:
 * a direct key for its family, else Bedrock credentials. (The old check
 * demanded Bedrock even for direct-key Astra/Fable setups.)
 */
async function routedExpansionAvailable(): Promise<boolean> {
  const models = env();
  const id = models.bedrock.modelId;
  if (!id) return false;
  const family = detectModelFamily(id);
  if (family === 'astra' && models.models.openaiApiKey) return true;
  if (family === 'fable' && models.models.anthropicApiKey) return true;
  return (await describeBedrockConfig()).configured;
}

/** Bedrock-backed expansion model (proposeChildren + the R2 decision-power call). */
export function bedrockExpansionModel(): ExpansionModel {
  return {
    async proposeChildren(input) {
      if (!(await routedExpansionAvailable())) return 'unavailable' as const;
      const result = await proposeExpansion({
        nodeLabel: input.node.label,
        nodeContent: input.node.content,
        nodeLevel: input.level,
        projectClass: input.projectClass,
        prompt: input.prompt,
        brief: input.brief,
        existingLabels: input.existingLabels,
      });
      if (!result.ok || result.payload === undefined) {
        return { ok: false, error: result.error ?? 'unparsable payload' };
      }
      const payload = result.payload as { children?: unknown };
      const children = Array.isArray(payload.children) ? payload.children.map(normaliseChild).filter((child): child is ProposedChild => child !== null) : [];
      if (children.length === 0) return { ok: false, error: 'model returned no usable children' };
      return { ok: true, children };
    },

    async decisionPower(input) {
      if (!(await routedExpansionAvailable())) return null;
      try {
        const result = await proposeDecisionPower({
          nodeLabel: input.node.label,
          nodeContent: input.node.content,
          realization: input.realization,
        });
        if (!result.ok || result.payload === undefined) return null;
        const payload = result.payload as { changes?: unknown; reason?: unknown };
        if (typeof payload.changes !== 'boolean') return null;
        return { changes: payload.changes, reason: asString(payload.reason, 200) };
      } catch {
        // R2 is an optimisation, never a gate: skipping it keeps R1/R3/R4 in charge.
        return null;
      }
    },
  };
}

/** True when a real model is configured for the idea-graph moves. */
export function ideaGraphModelAvailable(): boolean {
  return Boolean(env().bedrock.modelId);
}
