/**
 * Shared summariser for wireup workstate — turns a ProjectState into the
 * compact JSON both hardware_build and hardware_project return to the agent.
 */

import type { ProjectState } from "@forge/wireup";

export function summariseProject(state: ProjectState, includeCode = true): Record<string, unknown> {
  const code = state.artifacts.code;
  return {
    projectId: state.id,
    name: state.name,
    prompt: state.prompt,
    status: state.status,
    stage: state.stage,
    revision: state.revision,
    error: state.error,
    language: state.softwarePlan?.language ?? null,
    components: state.components.map((c) => ({
      id: c.id, name: c.name, quantity: c.quantity, role: c.role, source: c.source,
    })),
    pinAssignments: state.pinAssignments.length,
    wiring: {
      connections: (state.wiring?.connections ?? []).map((c) =>
        `${c.from.instanceId}:${c.from.pin} -> ${c.to.instanceId}:${c.to.pin} (${c.signal})`),
      nets: state.wiring?.nets.length ?? 0,
      notes: state.wiring?.notes ?? [],
    },
    code: includeCode && code ? {
      entryPoint: code.entryPoint,
      files: code.files.map((f) => ({ path: f.path, bytes: f.content.length, purpose: f.purpose, content: f.content })),
      notes: code.notes,
    } : (code ? { entryPoint: code.entryPoint, files: code.files.map((f) => ({ path: f.path, bytes: f.content.length })), notes: code.notes } : null),
    validation: state.validation ? {
      passed: state.validation.passed,
      errors: state.validation.summary.errors,
      warnings: state.validation.summary.warnings,
      checksRun: state.validation.summary.checksRun,
      issues: state.validation.issues.map((i) => ({
        code: i.code, severity: i.severity, domain: i.domain, message: i.message,
      })),
    } : null,
    revisions: state.revisions.map((r) => ({ version: r.version, reason: r.reason, createdAt: r.createdAt })),
  };
}