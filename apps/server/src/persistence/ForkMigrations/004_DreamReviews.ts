import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fork_dream_reviews (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    model_json TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    cutoff TEXT,
    snapshot_json TEXT,
    legacy_prompt TEXT,
    suggestions_json TEXT
  )`;
  yield* sql`CREATE INDEX fork_dream_reviews_project ON fork_dream_reviews(project_id)`;
  yield* sql`INSERT INTO fork_dream_reviews
    (thread_id, project_id, command_id, model_json, source_count, legacy_prompt)
    SELECT json_extract(payload_json, '$.threadId'), project_id, json_extract(payload_json, '$.commandId'),
      json_extract(payload_json, '$.modelSelection'), json_extract(payload_json, '$.sourceCount'),
      json_extract(payload_json, '$.text')
    FROM fork_dreams`;
  yield* sql`DROP TABLE fork_dreams`;
  yield* sql`CREATE TABLE fork_dream_requests (
    project_id TEXT NOT NULL, command_id TEXT NOT NULL, requester_id TEXT NOT NULL,
    dream_id TEXT NOT NULL REFERENCES fork_dream_reviews(thread_id),
    PRIMARY KEY (project_id, command_id, requester_id)
  )`;
  yield* sql`CREATE INDEX fork_dream_requests_requester ON fork_dream_requests(requester_id, dream_id)`;
});
