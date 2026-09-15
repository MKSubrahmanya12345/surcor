import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeDatabase } from "../../packages/server/src/db/client";

/**
 * CAD turns are persisted like any other chat message, with mode = "cad".
 * Prompt 3's `messages` table CHECK-listed the three original modes, so
 * widening `AgentMode` in the shared types was only half the job: databases
 * created before Prompt 7 have to be migrated, and new ones created with the
 * same file must already allow it. Both directions are tested here.
 */

const scratch = (name: string): string => join(mkdtempSync(`${tmpdir()}/forge-${name}-`), "forge.sqlite");

test("a fresh database stores a cad message and reads it back", () => {
  const database = new ForgeDatabase(scratch("cad-fresh"));
  const session = database.openSession("/tmp/workspace");
  const id = crypto.randomUUID();
  database.appendMessage(session.id, { id, role: "assistant", content: "CAD: verified existing manufacturer model.", mode: "cad", createdAt: Date.now() });
  const stored = database.getMessage(session.id, id);
  expect(stored?.mode).toBe("cad");
  expect(database.listMessages(session.id).map((message) => message.mode)).toEqual(["cad"]);
  // The three existing modes still store and read unchanged.
  for (const mode of ["ask", "agent", "plan"] as const) {
    const other = crypto.randomUUID();
    database.appendMessage(session.id, { id: other, role: "user", content: mode, mode, createdAt: Date.now() });
    expect(database.getMessage(session.id, other)?.mode).toBe(mode);
  }
  database.close();
});

test("a pre-Prompt-7 database is rebuilt once, keeps its rows, and then accepts cad", () => {
  const path = scratch("cad-migrate");
  // Recreate exactly the Prompt 3 shape, old CHECK and all.
  const legacy = new Database(path, { create: true, strict: true });
  legacy.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, pending_plan_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('ask', 'agent', 'plan')),
      tool_calls TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sessions VALUES ('s1', '/tmp/workspace', NULL, 1);
    INSERT INTO messages(id, session_id, role, content, mode, created_at)
      VALUES ('m1', 's1', 'user', 'legacy question', 'agent', 1),
             ('m2', 's1', 'assistant', 'legacy answer', 'plan', 2);
    INSERT INTO settings VALUES ('schema_version', '2');
  `);
  legacy.close();

  const database = new ForgeDatabase(path);
  const rows = database.listMessages("s1");
  expect(rows.map((row) => row.content)).toEqual(["legacy question", "legacy answer"]);
  expect(rows.map((row) => row.sequence ?? 0).length).toBe(2);

  // The constraint is gone, so the new mode is storable…
  const id = crypto.randomUUID();
  database.appendMessage("s1", { id, role: "assistant", content: "generated model", mode: "cad", createdAt: Date.now() });
  expect(database.getMessage("s1", id)?.mode).toBe("cad");

  // …and the widened CHECK is what now lives in sqlite_master (no rebuild loop).
  const schema = database.sqlite.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
  ).get().sql;
  expect(schema).toContain("'cad'");
  expect(database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages").get().count).toBe(3);
  database.close();

  // Opening it a second time must be a no-op, not a second rebuild.
  const again = new ForgeDatabase(path);
  expect(again.listMessages("s1").length).toBe(3);
  again.close();
});

test("an invalid mode is still rejected — the CHECK was widened, not removed", () => {
  const database = new ForgeDatabase(scratch("cad-reject"));
  const session = database.openSession("/tmp/workspace");
  expect(() => database.appendMessage(session.id, {
    id: crypto.randomUUID(), role: "user", content: "x", mode: "yolo" as never, createdAt: Date.now(),
  })).toThrow(/CHECK constraint/);
  database.close();
});
