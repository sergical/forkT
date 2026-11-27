import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_project_handoff_returns (
      run_id TEXT PRIMARY KEY REFERENCES orchestration_v2_projection_runs(run_id) ON DELETE CASCADE,
      project_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`CREATE INDEX fork_project_handoff_pending ON fork_project_handoff_returns(project_thread_id) WHERE delivered = 0`;
});
