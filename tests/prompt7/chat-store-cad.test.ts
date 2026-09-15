import { beforeAll, expect, mock, test } from "bun:test";
import type { ServerMessage } from "@forge/shared";

/**
 * Prompt 4's acceptance criteria said: Ask has no tools, Agent edits files,
 * Plan requires approval. Prompt 7 adds a fourth mode, so the regression risk
 * is that switching modes changes what the *other three* send. This file pins
 * the store-level behaviour for all four modes, and the CAD reduction rules
 * (progress appends, a result never survives into the next failure, cancel
 * frees the panel).
 *
 * The agent socket is replaced with a recorder: same interface, no WebSocket.
 */

const sent: unknown[] = [];
const listeners = new Set<(message: ServerMessage) => void>();

mock.module("../../packages/client/src/services/agentSocket", () => ({
  agentSocket: {
    connectionStatus: "connected",
    connect: () => undefined,
    setWorkspaceRoot: () => undefined,
    send: (message: unknown) => { sent.push(message); return true; },
    onMessage: (listener: (message: ServerMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatus: () => () => undefined,
  },
}));

let useChatStore: typeof import("../../packages/client/src/stores/useChatStore")["useChatStore"];

beforeAll(async () => {
  useChatStore = (await import("../../packages/client/src/stores/useChatStore")).useChatStore;
});

/** Each test starts from a connected, idle session — nothing bleeds sideways. */
const reset = (mode: "ask" | "agent" | "plan" | "cad" = "agent"): void => {
  sent.length = 0;
  useChatStore.setState({
    ready: true, busy: false, messages: [], pendingDiffs: [], pendingPlanId: null, serverError: null, mode,
    cad: { running: false, prompt: "", progress: [], result: null, failure: null, diagnostics: [] },
  });
};

const push = (message: ServerMessage): void => {
  for (const listener of listeners) listener(message);
};

test("Ask / Agent / Plan still send exactly what they sent before CAD existed", () => {
  for (const mode of ["ask", "agent", "plan"] as const) {
    reset(mode);
    useChatStore.getState().sendMessage(`hello from ${mode}`);
    expect(sent).toEqual([{ type: "user_message", content: `hello from ${mode}`, mode }]);
  }
});

test("CAD mode sends cad_generate instead — never a chat turn", () => {
  reset("cad");
  useChatStore.getState().sendMessage("a standard M8 hex bolt");
  expect(sent).toEqual([{ type: "cad_generate", prompt: "a standard M8 hex bolt" }]);
  const state = useChatStore.getState();
  expect(state.cad.running).toBe(true);
  expect(state.cad.prompt).toBe("a standard M8 hex bolt");
  expect(state.busy).toBe(true);
  // The prompt also lands in the transcript, so the mode switch is visible.
  expect(state.messages.at(-1)?.mode).toBe("cad");
  expect(state.messages.at(-1)?.role).toBe("user");
});

test("progress events append in order and keep the panel busy", () => {
  reset("cad");
  useChatStore.getState().requestCadModel("a standard M8 hex bolt");
  push({ type: "cad_progress", event: { stage: "searching_existing", detail: "no canonical file found" } });
  push({ type: "cad_progress", event: { stage: "spec_planning", detail: "Spec Planner: CADBrief written" } });
  push({ type: "cad_progress", event: { stage: "qa_pass", detail: "QA pass 1/3: checking fillets" } });
  const state = useChatStore.getState();
  // The queued line the store writes itself, then the three from the server.
  expect(state.cad.progress.map((line) => line.stage)).toEqual([
    "searching_existing", "searching_existing", "spec_planning", "qa_pass",
  ]);
  expect(state.cad.progress[0]?.detail).toContain("queued");
  expect(state.cad.progress[2]?.detail).toContain("CADBrief");
  expect(state.busy).toBe(true);
  expect(state.cad.running).toBe(true);
});

test("a verified model clears the run and is kept for the viewer", () => {
  reset("cad");
  useChatStore.getState().requestCadModel("a flange");
  push({ type: "cad_model_ready", result: {
    source: "generated", glbPath: "/x/model.glb", stepPath: "/x/model.step",
  } });
  const state = useChatStore.getState();
  expect(state.cad.result?.glbPath).toBe("/x/model.glb");
  expect(state.cad.failure).toBeNull();
  expect(state.cad.running).toBe(false);
  expect(state.busy).toBe(false);
  expect(state.cad.progress.at(-1)?.detail).toContain("QA passed");
});

test("a refusal replaces any previous model — no stale viewer under a failure card", () => {
  reset("cad");
  useChatStore.setState({ cad: { ...useChatStore.getState().cad, result: {
    source: "generated", glbPath: "/x/model.glb", stepPath: "/x/model.step",
  } } });
  push({ type: "cad_progress", event: { stage: "spec_planning", detail: "queued" } });
  push({ type: "cad_generation_failed", failure: {
    reason: "FILLET_FAILED on 2 fillet edge group(s) after 3 QA attempts", stage: "qa_pass",
  } });
  const state = useChatStore.getState();
  expect(state.cad.result).toBeNull();
  expect(state.cad.failure?.reason).toContain("FILLET_FAILED on 2");
  expect(state.cad.failure?.stage).toBe("qa_pass");
  expect(state.busy).toBe(false);
  expect(state.cad.running).toBe(false);
  // The reason is also the last log line, so the panel reads top-to-bottom.
  expect(state.cad.progress.at(-1)?.detail).toContain("FILLET_FAILED");
});

test("cancel releases both the chat turn and the CAD run", () => {
  reset("cad");
  useChatStore.getState().requestCadModel("a wristwatch");
  expect(useChatStore.getState().cad.running).toBe(true);
  sent.length = 0;
  useChatStore.getState().cancelTurn();
  expect(sent).toEqual([{ type: "cancel" }]);
  expect(useChatStore.getState().busy).toBe(false);
  expect(useChatStore.getState().cad.running).toBe(false);
});

test("a protocol error unblocks a CAD run that never got an answer", () => {
  reset("cad");
  useChatStore.getState().requestCadModel("a wheel");
  push({ type: "error", message: "A turn is already running. Send cancel before starting another." });
  expect(useChatStore.getState().busy).toBe(false);
  expect(useChatStore.getState().cad.running).toBe(false);
  expect(useChatStore.getState().serverError).toContain("already running");
});

test("clearCad resets the panel without touching chat state", () => {
  reset("cad");
  useChatStore.getState().requestCadModel("a wheel");
  useChatStore.getState().clearCad();
  const cad = useChatStore.getState().cad;
  expect(cad.progress).toEqual([]);
  expect(cad.result).toBeNull();
  expect(cad.failure).toBeNull();
  expect(useChatStore.getState().mode).toBe("cad");
});
