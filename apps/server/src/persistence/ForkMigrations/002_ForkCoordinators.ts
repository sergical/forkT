import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_coordinators (
      scope TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      model_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE fork_dreams (
      project_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    )
  `;
});
