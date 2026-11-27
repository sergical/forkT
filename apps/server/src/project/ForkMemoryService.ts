import {
  MAIN_COORDINATOR_MEMORY_SCOPE,
  ForkMemory,
  ForkMemoryError,
  ForkMemoryForgetInput,
  ForkMemoryIndexEntry,
  ForkMemoryIndexInput,
  ForkMemoryKey,
  ForkMemorySaveInput,
  ForkMemorySearchInput,
  ForkMemorySource,
  ForkMemorySummary,
  ProjectId,
  RunId,
} from "@t3tools/contracts";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
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
    /** Titles across personal memory and every live project, personal first, then by project. */
    readonly index: (
      input: ForkMemoryIndexInput,
    ) => Effect.Effect<ReadonlyArray<ForkMemoryIndexEntry>, ForkMemoryError>;
    readonly history: (
      input: ForkMemoryKey,
    ) => Effect.Effect<ReadonlyArray<ForkMemory>, ForkMemoryError>;
    readonly save: (input: ForkMemorySaveInput) => Effect.Effect<ForkMemory, ForkMemoryError>;
    readonly saveReviewed: (
      input: ForkMemorySaveInput,
      sources: ReadonlyArray<typeof ForkMemorySource.Type>,
    ) => Effect.Effect<ForkMemory, ForkMemoryError>;
    readonly matchesRevision: (
      key: ForkMemoryKey,
      expected: number,
    ) => Effect.Effect<boolean, ForkMemoryError>;
    readonly dreamMemories: (
      projectId: ProjectId,
    ) => Effect.Effect<
      ReadonlyArray<Pick<ForkMemory, "id" | "kind" | "revision" | "title" | "body">>,
      ForkMemoryError
    >;
    readonly forget: (input: ForkMemoryForgetInput) => Effect.Effect<void, ForkMemoryError>;
    readonly brief: (input: {
      readonly projectId: ProjectId;
      readonly runId: RunId;
      readonly query: string;
      readonly mainCoordinator?: boolean;
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
const traceScope = (projectId: ForkMemoryKey["projectId"]) =>
  projectId === null
    ? "personal"
    : projectId === MAIN_COORDINATOR_MEMORY_SCOPE
      ? "main"
      : "project";
const versionRef = ({
  projectId,
  id,
  revision,
}: Pick<ForkMemory, "projectId" | "id" | "revision">) =>
  hashTelemetryId(JSON.stringify([projectId, id, revision]));
const storageError = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ForkMemoryError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const checkProject = Effect.fn("ForkMemoryService.checkProject")(function* (
    projectId: ForkMemoryKey["projectId"],
  ) {
    if (projectId === null || projectId === MAIN_COORDINATOR_MEMORY_SCOPE) return;
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

  const get = Effect.fn("fork.memory.read")(function* (input: ForkMemoryKey) {
    yield* Effect.annotateCurrentSpan("fork.memory.scope", traceScope(input.projectId));
    yield* checkProject(input.projectId);
    const memory = (yield* read(input))?.payload ?? null;
    yield* Effect.annotateCurrentSpan({
      "fork.memory.found": memory !== null,
      ...(memory && {
        "fork.memory.version_ref": versionRef(memory),
        "fork.memory.revision": memory.revision,
        "fork.memory.source_count": memory.sources.length,
      }),
    });
    return memory;
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

  const search = Effect.fn("fork.memory.search")(function* (input: ForkMemorySearchInput) {
    yield* Effect.annotateCurrentSpan("fork.memory.scope", traceScope(input.projectId));
    const entries = yield* searchEntries(input);
    yield* Effect.annotateCurrentSpan("fork.memory.result_count", entries.length);
    return entries.map(({ projectId, id, kind, title, body, revision, updatedAt }) => ({
      projectId,
      id,
      kind,
      title,
      excerpt: body.slice(0, 300),
      revision,
      updatedAt,
    }));
  });

  const index = Effect.fn("ForkMemoryService.index")(function* (input: ForkMemoryIndexInput) {
    yield* Effect.annotateCurrentSpan("fork.memory.scope", "all");
    const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (input.query.trim() !== "" && terms.length === 0) {
      yield* Effect.annotateCurrentSpan("fork.memory.result_count", 0);
      return [];
    }
    // Prefix terms, all required: the palette searches as the user types.
    const match = terms.map((term) => `"${term}"*`).join(" AND ");
    // A deleted project's memories stay hidden, as `checkProject` hides them per scope.
    const rows = yield* (
      match === ""
        ? sql`
          SELECT m.payload_json AS payload, m.revision FROM fork_memories m
          LEFT JOIN projection_projects p ON p.project_id = substr(m.scope, 9)
          WHERE m.payload_json IS NOT NULL
            AND (m.scope IN ('personal', ${scopeOf(MAIN_COORDINATOR_MEMORY_SCOPE)}) OR (p.project_id IS NOT NULL AND p.deleted_at IS NULL))
          ORDER BY m.scope <> 'personal', m.scope,
            json_extract(m.payload_json, '$.updatedAt') DESC, m.memory_id
          LIMIT 500
        `
        : sql`
          SELECT m.payload_json AS payload, m.revision FROM fork_memory_search s
          JOIN fork_memories m ON m.scope = s.scope AND m.memory_id = s.memory_id
          LEFT JOIN projection_projects p ON p.project_id = substr(m.scope, 9)
          WHERE fork_memory_search MATCH ${match} AND m.payload_json IS NOT NULL
            AND (m.scope IN ('personal', ${scopeOf(MAIN_COORDINATOR_MEMORY_SCOPE)}) OR (p.project_id IS NOT NULL AND p.deleted_at IS NULL))
          ORDER BY m.scope <> 'personal', m.scope,
            bm25(fork_memory_search, 0, 0, 10.0, 1.0), m.memory_id
          LIMIT 50
        `
    ).pipe(Effect.flatMap(decodeRows));
    const entries = rows.flatMap((row) =>
      row.payload === null
        ? []
        : [
            {
              projectId: row.payload.projectId,
              id: row.payload.id,
              kind: row.payload.kind,
              title: row.payload.title,
              revision: row.payload.revision,
              updatedAt: row.payload.updatedAt,
            },
          ],
    );
    yield* Effect.annotateCurrentSpan("fork.memory.result_count", entries.length);
    return entries;
  }, Effect.mapError(storageError));

  const history = Effect.fn("fork.memory.history")(function* (input: ForkMemoryKey) {
    yield* Effect.annotateCurrentSpan("fork.memory.scope", traceScope(input.projectId));
    yield* checkProject(input.projectId);
    const rows = yield* sql`
      SELECT payload_json AS payload, revision FROM fork_memory_revisions
      WHERE scope = ${scopeOf(input.projectId)} AND memory_id = ${input.id}
      ORDER BY revision DESC LIMIT 100
    `.pipe(Effect.flatMap(decodeRows));
    const entries = rows.flatMap((row) => (row.payload === null ? [] : [row.payload]));
    yield* Effect.annotateCurrentSpan("fork.memory.result_count", entries.length);
    return entries;
  }, Effect.mapError(storageError));

  const brief = Effect.fn("fork.memory.brief")(function* (input: {
    readonly projectId: ProjectId;
    readonly runId: RunId;
    readonly query: string;
    readonly mainCoordinator?: boolean;
  }) {
    yield* Effect.annotateCurrentSpan({
      "fork.memory.scope": input.mainCoordinator ? "main" : "project",
      "fork.run.ref": hashTelemetryId(input.runId),
    });
    const { selection, reused } = yield* sql.withTransaction(
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
          const project = (yield* searchEntries({
            projectId: input.mainCoordinator ? MAIN_COORDINATOR_MEMORY_SCOPE : input.projectId,
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
        const selection = buildMemoryBrief(
          entries.flatMap((rows) =>
            rows.flatMap((row) => (row.payload === null ? [] : [row.payload])),
          ),
        );
        return { selection, reused: receipts.length > 0 };
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "fork.memory.receipt_reused": reused,
      "fork.memory.selected_version_refs": selection.references.map(versionRef),
      "fork.memory.selected_count": selection.references.length,
      "fork.memory.personal_selected_count": selection.references.filter(
        (ref) => ref.projectId === null,
      ).length,
    });
    return selection.text;
  }, Effect.mapError(storageError));

  const save = Effect.fn("fork.memory.save")(function* (
    raw: ForkMemorySaveInput,
    snapshotSources?: ReadonlyArray<typeof ForkMemorySource.Type>,
  ) {
    const input = yield* decodeSave(raw).pipe(
      Effect.mapError((cause) => new ForkMemoryError({ reason: "invalid", cause })),
    );
    yield* Effect.annotateCurrentSpan("fork.memory.scope", traceScope(input.projectId));
    const { memory, replayed } = yield* sql.withTransaction(
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
          return { memory: receipt, replayed: true };
        }
        if ((current?.revision ?? 0) !== input.expectedRevision) {
          return yield* new ForkMemoryError({ reason: "conflict" });
        }
        const sources: Array<typeof ForkMemorySource.Type> = [];
        for (const ref of input.sources) {
          const retained = (snapshotSources ?? current?.payload?.sources)?.find(
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
            AND (
              ${input.projectId} IS NULL OR t.project_id = ${input.projectId}
              OR (${input.projectId} = ${MAIN_COORDINATOR_MEMORY_SCOPE} AND t.thread_id LIKE 'fork:global:%')
            )
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
        return { memory, replayed: false };
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "fork.memory.replayed": replayed,
      "fork.memory.version_ref": versionRef(memory),
      "fork.memory.revision": memory.revision,
      "fork.memory.source_count": memory.sources.length,
      "fork.memory.kind": memory.kind,
    });
    return memory;
  }, Effect.mapError(storageError));

  const forget = Effect.fn("fork.memory.forget")(function* (input: ForkMemoryForgetInput) {
    yield* Effect.annotateCurrentSpan("fork.memory.scope", traceScope(input.projectId));
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

  const matchesRevision = Effect.fn("ForkMemoryService.matchesRevision")(function* (
    key: ForkMemoryKey,
    expected: number,
  ) {
    const [current] = yield* sql<{ revision: number; forgotten: number }>`
      SELECT revision, payload_json IS NULL AS forgotten FROM fork_memories
      WHERE scope = ${scopeOf(key.projectId)} AND memory_id = ${key.id}`;
    return current ? !current.forgotten && current.revision === expected : expected === 0;
  }, Effect.mapError(storageError));

  const dreamMemories = Effect.fn("ForkMemoryService.dreamMemories")(function* (
    projectId: ProjectId,
  ) {
    yield* checkProject(projectId);
    const entries = yield* sql<Pick<ForkMemory, "id" | "kind" | "revision" | "title" | "body">>`
      SELECT memory_id AS id, revision, json_extract(payload_json, '$.kind') AS kind,
        json_extract(payload_json, '$.title') AS title, json_extract(payload_json, '$.body') AS body
      FROM fork_memories WHERE scope = ${scopeOf(projectId)} AND payload_json IS NOT NULL
      ORDER BY json_extract(payload_json, '$.updatedAt') DESC, memory_id LIMIT 20`;
    let remaining = 16_000;
    return entries.flatMap(({ id, kind, revision, title, body }) => {
      if (body.length + title.length > remaining) return [];
      remaining -= body.length + title.length;
      return [{ id, kind, revision, title, body }];
    });
  }, Effect.mapError(storageError));

  return ForkMemoryService.of({
    get,
    search,
    index,
    history,
    save,
    saveReviewed: save,
    matchesRevision,
    dreamMemories,
    forget,
    brief,
  });
});

export const layer = Layer.effect(ForkMemoryService, make);
