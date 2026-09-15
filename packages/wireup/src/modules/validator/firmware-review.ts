import { z } from 'zod';

import { reviewFirmware } from '@/lib/bedrock';
import type { LlmCallRecord, ProjectState } from '@/types/project';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

const FirmwareReviewSchema = z.object({
  issues: z.array(z.object({
    file: z.string().optional(),
    line: z.number().optional(),
    message: z.string(),
  }).passthrough()).optional(),
  notes: z.array(z.string()).optional(),
}).passthrough();

export interface FirmwareReviewResult {
  call: LlmCallRecord;
  issues: string[];
  notes: string[];
}

export async function runFirmwareReview(project: ProjectState): Promise<FirmwareReviewResult> {
  const startedAt = Date.now();
  const call: LlmCallRecord = {
    id: createId('llm'),
    op: 'firmware_review',
    model: 'unknown',
    startedAt: nowIso(),
    status: 'failed',
    iteration: 0,
  };

  try {
    const code = project.artifacts.code;
    const response = await reviewFirmware({
      prompt: project.prompt,
      controller: project.hardwarePlan?.controller?.name ?? 'the selected controller',
      entryPoint: code?.entryPoint ?? 'sketch.ino',
      files: code?.files.map((file) => ({ path: file.path, content: file.content })) ?? [],
      pinAssignments: project.pinAssignments,
      libraries: project.artifacts.libraries?.libraries.map((library) => library.name) ?? [],
    });

    call.model = response.model;
    call.finishedAt = nowIso();
    call.durationMs = Date.now() - startedAt;
    call.inputTokens = response.usage.inputTokens;
    call.outputTokens = response.usage.outputTokens;

    if (!response.ok || response.payload === undefined) {
      call.error = response.error ?? 'Firmware review returned no parsable payload.';
      return { call, issues: [], notes: [call.error] };
    }

    const parsed = FirmwareReviewSchema.safeParse(response.payload);
    if (!parsed.success) {
      call.error = 'Firmware review payload did not match its contract.';
      return { call, issues: [], notes: [call.error] };
    }

    call.status = 'ok';
    return {
      call,
      issues: (parsed.data.issues ?? []).map((issue) => `${issue.file ?? 'firmware'}${issue.line ? `:${issue.line}` : ''} — ${issue.message}`),
      notes: parsed.data.notes ?? [],
    };
  } catch (error) {
    call.finishedAt = nowIso();
    call.durationMs = Date.now() - startedAt;
    call.error = error instanceof Error ? error.message : String(error);
    return { call, issues: [], notes: [call.error] };
  }
}