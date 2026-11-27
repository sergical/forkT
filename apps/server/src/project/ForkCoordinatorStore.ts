import {
  ForkCoordinatorError,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type ForkCoordinatorOpenInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const CoordinatorRecord = Schema.Struct({
  scope: Schema.String,
  projectId: ProjectId,
  generation: Schema.Number,
  threadId: ThreadId,
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
});
type CoordinatorRecord = typeof CoordinatorRecord.Type;
const decode = Schema.decodeUnknownEffect(Schema.Array(CoordinatorRecord));
const encodeModel = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const failure = () => new ForkCoordinatorError({ message: "Could not access the coordinator." });
const scopeOf = (input: Pick<ForkCoordinatorOpenInput, "projectId" | "global">) =>
  input.global ? "global" : `project:${input.projectId}`;

export function defaultCoordinatorTitle(global: boolean) {
  return global ? "forkT · Main coordinator" : "forkT · Project coordinator";
}

export class ForkCoordinatorStore extends Context.Service<
  ForkCoordinatorStore,
  {
    readonly get: (
      input: Pick<ForkCoordinatorOpenInput, "projectId" | "global">,
    ) => Effect.Effect<CoordinatorRecord | null, ForkCoordinatorError>;
    readonly listLegacyDefaultTitles: Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly scope: string }>,
      ForkCoordinatorError
    >;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<CoordinatorRecord | null, ForkCoordinatorError>;
    readonly claim: (
      input: ForkCoordinatorOpenInput & {
        readonly projectId: ProjectId;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
      },
    ) => Effect.Effect<CoordinatorRecord, ForkCoordinatorError>;
  }
>()("t3/project/ForkCoordinatorStore") {}

export const layer = Layer.effect(
  ForkCoordinatorStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = Effect.fn("ForkCoordinatorStore.get")(function* (
      input: Pick<ForkCoordinatorOpenInput, "projectId" | "global">,
    ) {
      return (
        (yield* sql`
      SELECT scope, project_id AS projectId, generation, thread_id AS threadId, model_json AS modelSelection, runtime_mode AS runtimeMode
      FROM fork_coordinators WHERE scope = ${scopeOf(input)}
    `.pipe(Effect.flatMap(decode)))[0] ?? null
      );
    }, Effect.mapError(failure));
    const forThread = Effect.fn("ForkCoordinatorStore.forThread")(function* (threadId: ThreadId) {
      return (
        (yield* sql`
      SELECT scope, project_id AS projectId, generation, thread_id AS threadId, model_json AS modelSelection, runtime_mode AS runtimeMode
      FROM fork_coordinators WHERE thread_id = ${threadId}
    `.pipe(Effect.flatMap(decode)))[0] ?? null
      );
    }, Effect.mapError(failure));
    const claim = Effect.fn("ForkCoordinatorStore.claim")(function* (
      input: ForkCoordinatorOpenInput & {
        readonly projectId: ProjectId;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
      },
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* get(input);
          const deleted =
            current === null
              ? []
              : yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${current.threadId} AND deleted_at IS NOT NULL`;
          if (current !== null && deleted.length === 0) {
            const live =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${current.threadId}`;
            if (live.length > 0) return current;
            const model = yield* encodeModel(input.modelSelection);
            yield* sql`UPDATE fork_coordinators SET model_json = ${model}, runtime_mode = ${input.runtimeMode} WHERE scope = ${current.scope}`;
            return {
              ...current,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
            };
          }
          const scope = scopeOf(input);
          const generation = (current?.generation ?? 0) + 1;
          const threadId = ThreadId.make(`fork:${scope}:${generation}`);
          const model = yield* encodeModel(input.modelSelection);
          yield* sql`
        INSERT INTO fork_coordinators (scope, project_id, generation, thread_id, model_json, runtime_mode)
        VALUES (${scope}, ${input.projectId}, ${generation}, ${threadId}, ${model}, ${input.runtimeMode})
        ON CONFLICT (scope) DO UPDATE SET project_id = excluded.project_id, generation = excluded.generation,
          thread_id = excluded.thread_id, model_json = excluded.model_json, runtime_mode = excluded.runtime_mode
      `;
          return {
            scope,
            projectId: input.projectId,
            generation,
            threadId,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
          };
        }),
      );
    }, Effect.mapError(failure));
    // Start with the coordinator registry so opening a workspace never scans all its threads.
    const listLegacyDefaultTitles = sql<{ readonly threadId: ThreadId; readonly scope: string }>`
      SELECT c.thread_id AS threadId, c.scope
      FROM fork_coordinators c CROSS JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
      WHERE t.deleted_at IS NULL AND t.title = CASE WHEN c.scope = 'global'
        THEN 'T3 fork · Main coordinator' ELSE 'T3 fork · Project coordinator' END
        AND coalesce(json_extract(t.payload_json, '$.titleRenamed'), 0) = 0
    `.pipe(Effect.mapError(failure));
    return ForkCoordinatorStore.of({ get, forThread, claim, listLegacyDefaultTitles });
  }),
);
