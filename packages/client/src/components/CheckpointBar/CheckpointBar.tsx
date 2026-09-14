import { useState } from "react";
import { useChatStore } from "../../stores/useChatStore";

/**
 * Small strip above the chat input. Checkpoints are created client-side the
 * first time a turn emits a write-type tool call, snapshotting every file
 * open in a tab. "Restore" writes the most recent snapshot back to disk via
 * Prompt 1's fs:writeFile IPC handler and refreshes the open tabs.
 */
export function CheckpointBar() {
  const checkpoints = useChatStore((state) => state.checkpoints);
  const restoreLastCheckpoint = useChatStore((state) => state.restoreLastCheckpoint);
  const [restoring, setRestoring] = useState(false);

  const latest = checkpoints[checkpoints.length - 1];
  if (!latest) return null;

  const restore = async (): Promise<void> => {
    if (restoring) return;
    setRestoring(true);
    try {
      await restoreLastCheckpoint();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="checkpoint-bar">
      <span
        className="checkpoint-label"
        title={`${latest.label} — ${latest.fileSnapshots.length} file(s) snapshotted`}
      >
        ⧉ {latest.label} · {new Date(latest.createdAt).toLocaleTimeString()}
        {checkpoints.length > 1 ? ` (${checkpoints.length} checkpoints)` : ""}
      </span>
      <button
        type="button"
        className="secondary-button checkpoint-restore"
        disabled={restoring}
        onClick={() => void restore()}
      >
        {restoring ? "Restoring…" : "Restore to before last change"}
      </button>
    </div>
  );
}
