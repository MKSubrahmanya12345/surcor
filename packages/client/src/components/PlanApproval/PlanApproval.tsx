import { useChatStore } from "../../stores/useChatStore";

/**
 * Rendered directly under the plan message while the server has a pending
 * plan. Approve sends the approve_plan ClientMessage (added in Prompt 3);
 * nothing is executed until it is sent. "Edit plan" hands control back to
 * the composer in Plan mode so the user can request a revision.
 */
export function PlanApproval({ onEdit }: { onEdit?: () => void }) {
  const approvePlan = useChatStore((state) => state.approvePlan);
  const busy = useChatStore((state) => state.busy);
  const ready = useChatStore((state) => state.ready);

  return (
    <div className="plan-approval">
      <p className="plan-approval-hint">
        Plan ready. Nothing has been changed yet — approve to let Forge execute it,
        or edit the plan to request a revision.
      </p>
      <div className="plan-approval-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !ready}
          onClick={approvePlan}
        >
          Approve
        </button>
        <button type="button" className="secondary-button" onClick={onEdit}>
          Edit plan
        </button>
      </div>
    </div>
  );
}
