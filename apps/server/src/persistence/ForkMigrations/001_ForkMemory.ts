import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_memories (
      scope TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT,
      PRIMARY KEY (scope, memory_id)
    )
  `;
  yield* sql`
    CREATE TABLE fork_memory_revisions (
      scope TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (scope, memory_id, revision)
    )
  `;
  yield* sql`
    CREATE VIRTUAL TABLE fork_memory_search USING fts5(scope UNINDEXED, memory_id UNINDEXED, title, body)
  `;
  yield* sql`
    CREATE TABLE fork_memory_briefs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      references_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE TRIGGER fork_memory_briefs_run_deleted AFTER DELETE ON orchestration_v2_projection_runs
    BEGIN DELETE FROM fork_memory_briefs WHERE run_id = OLD.run_id; END`;
  yield* sql`CREATE TRIGGER fork_memory_briefs_thread_deleted AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads
    WHEN NEW.deleted_at IS NOT NULL
    BEGIN DELETE FROM fork_memory_briefs WHERE run_id IN (SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = NEW.thread_id); END`;
});
