import {
  ForkMemory,
  ForkMemoryError,
  ForkMemoryForgetInput,
  ForkMemoryKey,
  ForkMemorySaveInput,
  ForkMemorySearchInput,
  ForkMemorySource,
  ForkMemorySummary,
  ProjectId,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { buildMemoryBrief } from "./forkMemoryBrief.ts";

export class ForkMemoryService extends Context.Service<
  ForkMemoryService,
  {
    readonly get: (input: ForkMemoryKey) => Effect.Effect<ForkMemory | null, ForkMemoryError>;
    readonly search: (
      input: ForkMemorySearchInput,
    ) => Effect.Effect<ReadonlyArray<ForkMemorySummary>, ForkMemoryError>;
    readonly history: (
      input: ForkMemoryKey,
    ) => Effect.Effect<ReadonlyArray<ForkMemory>, ForkMemoryError>;
    readonly save: (input: ForkMemorySaveInput) => Effect.Effect<ForkMemory, ForkMemoryError>;
    readonly forget: (input: ForkMemoryForgetInput) => Effect.Effect<void, ForkMemoryError>;
    readonly brief: (input: {
      readonly projectId: ProjectId;
      readonly runId: RunId;
      readonly query: string;
      readonly includeProject?: boolean;
    }) => Effect.Effect<string, ForkMemoryError>;
  }
>()("t3/project/ForkMemoryService") {}

const MemoryRow = Schema.Struct({
  payload: Schema.NullOr(Schema.fromJsonString(ForkMemory)),
  revision: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(MemoryRow));
const decodeSources = Schema.decodeUnknownEffect(Schema.Array(ForkMemorySource));
const encodeMemory = Schema.encodeEffect(Schema.fromJsonString(ForkMemory));
const decodeSave = Schema.decodeEffect(ForkMemorySaveInput);
const BriefReferences = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      ...ForkMemoryKey.fields,
      revision: ForkMemory.fields.revision,
    }),
  ),
);
const encodeReferences = Schema.encodeEffect(BriefReferences);
const decodeBriefRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      references: BriefReferences,
    }),
  ),
);
const isMemoryError = Schema.is(ForkMemoryError);
const scopeOf = (projectId: ForkMemoryKey["projectId"]) =>
  projectId === null ? "personal" : `project:${projectId}`;
const storageError = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ForkMemoryError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const checkProject = Effect.fn("ForkMemoryService.checkProject")(function* (
    projectId: ForkMemoryKey["projectId"],
  ) {
    if (projectId === null) return;
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
    if (rows.length === 0) return yield* new ForkMemoryError({ reason: "not_found" });
  });

  const read = Effect.fn("ForkMemoryService.read")(function* (input: ForkMemoryKey) {
    const rows = yield* sql`
      SELECT payload_json AS payload, revision FROM fork_memories
      WHERE scope = ${scopeOf(input.projectId)} AND memory_id = ${input.id}
    `.pipe(Effect.flatMap(decodeRows));
    return rows[0];
  });

  const get = Effect.fn("ForkMemoryService.get")(function* (input: ForkMemoryKey) {
    yield* checkProject(input.projectId);
    return (yield* read(input))?.payload ?? null;
  }, Effect.mapError(storageError));

  const searchEntries = Effect.fn("ForkMemoryService.searchEntries")(function* (
    input: ForkMemorySearchInput,
  ) {
    yield* checkProject(input.projectId);
    const scope = scopeOf(input.projectId);
    const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (input.query.trim() !== "" && terms.length === 0) return [];
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = yield* (
      match === ""
        ? sql`
          SELECT payload_json AS payload, revision FROM fork_memories
          WHERE scope = ${scope} AND payload_json IS NOT NULL
          ORDER BY json_extract(payload_json, '$.updatedAt') DESC, memory_id LIMIT 100
        `
        : sql`
          SELECT m.payload_json AS payload, m.revision FROM fork_memory_search s
          JOIN fork_memories m ON m.scope = s.scope AND m.memory_id = s.memory_id
          WHERE fork_memory_search MATCH ${match} AND s.scope = ${scope} AND m.payload_json IS NOT NULL
          ORDER BY rank, m.memory_id LIMIT 20
        `
    ).pipe(Effect.flatMap(decodeRows));
    return rows.flatMap((row) => (row.payload === null ? [] : [row.payload]));
  }, Effect.mapError(storageError));

  const search = Effect.fn("ForkMemoryService.search")(function* (input: ForkMemorySearchInput) {
    return (yield* searchEntries(input)).map(
      ({ projectId, id, kind, title, body, revision, updatedAt }) => ({
        projectId,
        id,
        kind,
        title,
        excerpt: body.slice(0, 300),
        revision,
        updatedAt,
      }),
    );
  });

  const history = Effect.fn("ForkMemoryService.history")(function* (input: ForkMemoryKey) {
    yield* checkProject(input.projectId);
    const rows = yield* sql`
      SELECT payload_json AS payload, revision FROM fork_memory_revisions
      WHERE scope = ${scopeOf(input.projectId)} AND memory_id = ${input.id}
      ORDER BY revision DESC LIMIT 100
    `.pipe(Effect.flatMap(decodeRows));
    return rows.flatMap((row) => (row.payload === null ? [] : [row.payload]));
  }, Effect.mapError(storageError));

  const brief = Effect.fn("ForkMemoryService.brief")(function* (input: {
    readonly projectId: ProjectId;
    readonly runId: RunId;
    readonly query: string;
    readonly includeProject?: boolean;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkProject(input.projectId);
        const receipts = yield* sql`
        SELECT project_id AS projectId, references_json AS "references"
        FROM fork_memory_briefs WHERE run_id = ${input.runId}
      `.pipe(Effect.flatMap(decodeBriefRows));
        let references = receipts[0]?.references;
        if (receipts[0] !== undefined && receipts[0].projectId !== input.projectId) {
          return yield* new ForkMemoryError({ reason: "invalid" });
        }
        if (references === undefined) {
          const personal = (yield* searchEntries({ projectId: null, query: "" }))
            .filter((entry) => entry.kind === "preference")
            .slice(0, 3);
          const project =
            input.includeProject === false
              ? []
              : (yield* searchEntries({
                  projectId: input.projectId,
                  query: input.query.slice(0, 500),
                })).slice(0, 8);
          references = buildMemoryBrief([...personal, ...project]).references;
          const encoded = yield* encodeReferences(references);
          yield* sql`
          INSERT INTO fork_memory_briefs (run_id, project_id, references_json)
          VALUES (${input.runId}, ${input.projectId}, ${encoded})
        `;
        }
        const entries = yield* Effect.forEach(references, (ref) =>
          sql`
        SELECT r.payload_json AS payload, r.revision FROM fork_memory_revisions r
        JOIN fork_memories m ON m.scope = r.scope AND m.memory_id = r.memory_id
        WHERE r.scope = ${scopeOf(ref.projectId)} AND r.memory_id = ${ref.id}
          AND r.revision = ${ref.revision} AND m.payload_json IS NOT NULL
      `.pipe(Effect.flatMap(decodeRows)),
        );
        return buildMemoryBrief(
          entries.flatMap((rows) =>
            rows.flatMap((row) => (row.payload === null ? [] : [row.payload])),
          ),
        ).text;
      }),
    );
  }, Effect.mapError(storageError));

  const save = Effect.fn("ForkMemoryService.save")(function* (raw: ForkMemorySaveInput) {
    const input = yield* decodeSave(raw).pipe(
      Effect.mapError((cause) => new ForkMemoryError({ reason: "invalid", cause })),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkProject(input.projectId);
        const scope = scopeOf(input.projectId);
        const current = yield* read(input);
        if (current?.payload === null) return yield* new ForkMemoryError({ reason: "forgotten" });
        const previous = yield* sql`
        SELECT payload_json AS payload, revision FROM fork_memory_revisions WHERE command_id = ${input.commandId}
      `.pipe(Effect.flatMap(decodeRows));
        const receipt = previous[0]?.payload;
        if (receipt !== undefined && receipt !== null) {
          if (
            receipt.id !== input.id ||
            receipt.projectId !== input.projectId ||
            receipt.revision !== input.expectedRevision + 1 ||
            receipt.kind !== input.kind ||
            receipt.title !== input.title ||
            receipt.body !== input.body ||
            receipt.reason !== input.reason ||
            receipt.sources.length !== input.sources.length ||
            receipt.sources.some(
              (source, index) =>
                source.threadId !== input.sources[index]?.threadId ||
                source.messageId !== input.sources[index]?.messageId,
            )
          ) {
            return yield* new ForkMemoryError({ reason: "invalid" });
          }
          return receipt;
        }
        if ((current?.revision ?? 0) !== input.expectedRevision) {
          return yield* new ForkMemoryError({ reason: "conflict" });
        }
        const sources: Array<typeof ForkMemorySource.Type> = [];
        for (const ref of input.sources) {
          const retained = current?.payload?.sources.find(
            (source) => source.threadId === ref.threadId && source.messageId === ref.messageId,
          );
          if (retained !== undefined) {
            sources.push(retained);
            continue;
          }
          const rows = yield* sql`
          SELECT m.thread_id AS threadId, m.message_id AS messageId, substr(json_extract(m.payload_json, '$.text'), 1, 4000) AS text
          FROM orchestration_v2_projection_messages m
          JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
          WHERE m.message_id = ${ref.messageId} AND m.thread_id = ${ref.threadId}
            AND m.streaming = 0 AND t.deleted_at IS NULL
            AND json_type(m.payload_json, '$.text') = 'text' 
            AND (${input.projectId} IS NULL OR t.project_id = ${input.projectId})
        `.pipe(Effect.flatMap(decodeSources));
          const source = rows[0];
          if (source === undefined)
            return yield* new ForkMemoryError({ reason: "source_unavailable" });
          sources.push(source);
        }
        const memory: ForkMemory = {
          projectId: input.projectId,
          id: input.id,
          kind: input.kind,
          title: input.title,
          body: input.body,
          revision: input.expectedRevision + 1,
          reason: input.reason,
          sources,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        const payload = yield* encodeMemory(memory);
        yield* sql`
        INSERT INTO fork_memories (scope, memory_id, revision, payload_json)
        VALUES (${scope}, ${input.id}, ${memory.revision}, ${payload})
        ON CONFLICT (scope, memory_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json
      `;
        yield* sql`
        INSERT INTO fork_memory_revisions (scope, memory_id, revision, command_id, payload_json)
        VALUES (${scope}, ${input.id}, ${memory.revision}, ${input.commandId}, ${payload})
      `;
        yield* sql`DELETE FROM fork_memory_search WHERE scope = ${scope} AND memory_id = ${input.id}`;
        yield* sql`INSERT INTO fork_memory_search (scope, memory_id, title, body) VALUES (${scope}, ${input.id}, ${input.title}, ${input.body})`;
        return memory;
      }),
    );
  }, Effect.mapError(storageError));

  const forget = Effect.fn("ForkMemoryService.forget")(function* (input: ForkMemoryForgetInput) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkProject(input.projectId);
        const current = yield* read(input);
        if (current === undefined) return yield* new ForkMemoryError({ reason: "not_found" });
        if (current.revision !== input.expectedRevision)
          return yield* new ForkMemoryError({ reason: "conflict" });
        const scope = scopeOf(input.projectId);
        yield* sql`UPDATE fork_memories SET payload_json = NULL WHERE scope = ${scope} AND memory_id = ${input.id}`;
        yield* sql`DELETE FROM fork_memory_revisions WHERE scope = ${scope} AND memory_id = ${input.id}`;
        yield* sql`DELETE FROM fork_memory_search WHERE scope = ${scope} AND memory_id = ${input.id}`;
      }),
    );
  }, Effect.mapError(storageError));

  return ForkMemoryService.of({ get, search, history, save, forget, brief });
});

export const layer = Layer.effect(ForkMemoryService, make);
