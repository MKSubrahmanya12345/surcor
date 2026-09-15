/**
 * Behavioural report → validation findings (the single source).
 *
 * `evaluateBehavioral` produces a report; the validator and the Everflow act
 * phase both need to fold that report into a `ValidationResult` using the
 * exact same vocabulary:
 *
 *   • one aggregate check  `behavior.assertions`,
 *   • one check PER ASSERTION `behavioral.<assertionId>` — the ids the
 *     Everflow evaluator and materialiser read to judge `behaviour_proven`
 *     goals BY CODE (a promise the emulator proved must satisfy its goal
 *     without a human), and
 *   • one auto-fixable `behavioral_assertion_failed` issue per failed
 *     assertion, which the fixer receives as structured input.
 *
 * Keeping this in one place is what lets the act phase re-run the emulator
 * mid-loop and merge the outcome without drifting from what the build-time
 * validator would have written.
 */

import type { BehavioralReport } from '@/types/behavioral';
import type { ValidationCheck, ValidationIssue } from '@/types/validation';

export interface BehavioralFindings {
  /** The aggregate check first, then one check per assertion. */
  checks: ValidationCheck[];
  /** One issue per failed assertion. */
  issues: ValidationIssue[];
}

export function behavioralFindings(report: BehavioralReport): BehavioralFindings {
  const issues: ValidationIssue[] = [];
  const behavioralIssueIds: string[] = [];

  for (const check of report.checks) {
    if (check.status !== 'failed') continue;
    const issue: ValidationIssue = {
      id: `behavioral.${check.assertionId}`,
      code: 'behavioral_assertion_failed',
      severity: check.severity,
      domain: 'behavior',
      message: `Behavioural assertion failed: ${check.title} (${check.mode})`,
      details: check.failure ?? `expected ${check.expected}, got ${check.actual}`,
      target: { artifact: 'code' },
      fixHint: check.failure ?? `expected ${check.expected}, got ${check.actual}`,
      autoFixable: true,
      origin: 'rules',
    };
    issues.push(issue);
    behavioralIssueIds.push(issue.id);
  }

  const checks: ValidationCheck[] = [
    {
      id: 'behavior.assertions',
      name: 'Behavioural assertions',
      domain: 'behavior',
      status: report.failures > 0 ? 'failed' : report.checks.length > 0 ? 'passed' : 'skipped',
      message: report.runtimeError
        ? `${report.checks.length} assertion(s) checked statically; emulation unavailable (${report.runtimeError}).`
        : `${report.checks.length} assertion(s) checked (${report.checks.filter((c) => c.status === 'passed').length} passed, ${report.failures + report.warnings} failed)${report.runtimeRan ? ', emulation ran' : ''}.`,
      issueIds: behavioralIssueIds,
    },
  ];

  for (const entry of report.checks) {
    checks.push({
      id: `behavioral.${entry.assertionId}`,
      name: entry.title,
      domain: 'behavior',
      status: entry.status === 'passed' ? 'passed' : entry.status === 'failed' ? 'failed' : 'skipped',
      message:
        entry.status === 'passed'
          ? `Proven by the ${entry.mode} evaluator: expected ${entry.expected}, observed ${entry.actual}.`
          : entry.reason ?? entry.failure ?? `Expected ${entry.expected}, got ${entry.actual}.`,
      issueIds: entry.status === 'failed' ? [`behavioral.${entry.assertionId}`] : [],
    });
  }

  return { checks, issues };
}
