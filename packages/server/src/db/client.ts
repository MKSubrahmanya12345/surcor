import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentDatabase, AgentSession, ChatMessage, DiffProposal,
  StoredChatMessage, StoredDiffProposal, StoredSetting, ToolCall,
} from "@forge/shared";

export class ForgeDatabase implements AgentDatabase {
  readonly sqlite: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(path, { create: true, strict: true });
    if (path !== ":memory:" && process.platform !== "win32") chmodSync(path, 0o600);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.sqlite.transaction(() => {
      this.sqlite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    })();
    this.ensureCadMode();
  }

  /**
   * Prompt 7: databases created before CAD mode carry
   * `CHECK (mode IN ('ask','agent','plan'))`, which rejects the `cad` rows the
   * new mode persists. SQLite has no ALTER CONSTRAINT, so the table is rebuilt
   * once — same columns, same indexes, widened CHECK. It runs only when
   * sqlite_master says the old constraint is still there, so every later boot is
   * a no-op read of one row.
   */
  private ensureCadMode(): void {
    const row = this.sqlite.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
    ).get();
    if (!row?.sql || /'cad'/.test(row.sql)) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE messages_prompt7 (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
          content TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('ask', 'agent', 'plan', 'cad')),
          tool_calls TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO messages_prompt7(sequence, id, session_id, role, content, mode, tool_calls, created_at)
          SELECT sequence, id, session_id, role, content, mode, tool_calls, created_at FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_prompt7 RENAME TO messages;
        CREATE INDEX IF NOT EXISTS messages_session_sequence ON messages(session_id, sequence);
      `);
    })();
  }

  openSession(workspaceRoot: string, sessionId?: string): AgentSession {
    if (sessionId) {
      const session = this.sqlite.query<AgentSession, [string]>(
        "SELECT id, workspace_root AS workspaceRoot, pending_plan_id AS pendingPlanId FROM sessions WHERE id = ?",
      ).get(sessionId);
      if (!session || session.workspaceRoot !== workspaceRoot) {
        throw new Error("Session does not belong to this workspace.");
      }
      return session;
    }
    const session: AgentSession = { id: crypto.randomUUID(), workspaceRoot, pendingPlanId: null };
    this.sqlite.query("INSERT INTO sessions(id, workspace_root, created_at) VALUES (?, ?, ?)")
      .run(session.id, workspaceRoot, Date.now());
    return session;
  }

  listMessages(sessionId: string, limit = 200): ChatMessage[] {
    const rows = this.sqlite.query<StoredChatMessage, [string, number]>(`
      SELECT id, role, content, mode, created_at AS createdAt, tool_calls AS toolCallsJson
      FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT ?)
      ORDER BY sequence ASC
    `).all(sessionId, limit);
    return rows.map((row) => this.decodeMessage(row));
  }

  getMessage(sessionId: string, messageId: string): ChatMessage | undefined {
    const row = this.sqlite.query<StoredChatMessage, [string, string]>(`
      SELECT id, role, content, mode, created_at AS createdAt, tool_calls AS toolCallsJson
      FROM messages WHERE session_id = ? AND id = ?
    `).get(sessionId, messageId);
    return row ? this.decodeMessage(row) : undefined;
  }

  private decodeMessage(row: StoredChatMessage): ChatMessage {
    return {
      id: row.id, role: row.role, content: row.content, mode: row.mode, createdAt: row.createdAt,
      ...(row.toolCallsJson ? { toolCalls: JSON.parse(row.toolCallsJson) as ToolCall[] } : {}),
    };
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    this.sqlite.query(`
      INSERT INTO messages(id, session_id, role, content, mode, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, sessionId, message.role, message.content, message.mode,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null, message.createdAt);
  }

  setPendingPlan(sessionId: string, messageId: string | null): void {
    this.sqlite.query("UPDATE sessions SET pending_plan_id = ? WHERE id = ?").run(messageId, sessionId);
  }

  saveDiff(sessionId: string, diff: DiffProposal): void {
    this.sqlite.query(`
      INSERT INTO diff_proposals(id, session_id, file_path, original_content, proposed_content, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(diff.id, sessionId, diff.filePath, diff.originalContent, diff.proposedContent, diff.status, Date.now());
  }

  listPendingDiffs(sessionId: string): DiffProposal[] {
    return this.sqlite.query<DiffProposal, [string]>(`
      SELECT id, file_path AS filePath, original_content AS originalContent,
             proposed_content AS proposedContent, status
      FROM diff_proposals WHERE session_id = ? AND status = 'pending' ORDER BY created_at, id
    `).all(sessionId);
  }

  decideDiff(sessionId: string, diffId: string, decision: "accept" | "reject"): DiffProposal {
    return this.sqlite.transaction(() => {
      const diff = this.sqlite.query<StoredDiffProposal, [string, string]>(`
        SELECT id, session_id AS sessionId, file_path AS filePath, original_content AS originalContent,
               proposed_content AS proposedContent, status FROM diff_proposals WHERE id = ? AND session_id = ?
      `).get(diffId, sessionId);
      if (!diff) throw new Error("Unknown diff proposal for this session.");
      const status = decision === "accept" ? "accepted" : "rejected";
      if (diff.status !== "pending" && diff.status !== status) throw new Error("Diff has already been decided.");
      this.sqlite.query("UPDATE diff_proposals SET status = ? WHERE id = ? AND session_id = ?")
        .run(status, diffId, sessionId);
      // Approval only records the decision. Prompt 4 writes through fs:writeFile.
      return { id: diff.id, filePath: diff.filePath, originalContent: diff.originalContent,
        proposedContent: diff.proposedContent, status };
    })();
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.sqlite.query<StoredSetting, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) as T : undefined;
  }

  setSetting(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Settings must be JSON serializable.");
    this.sqlite.query("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, json);
  }

  close(): void { this.sqlite.close(); }
}
