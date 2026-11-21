import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForkCoordinatorService from "./ForkCoordinatorService.ts";
import * as ForkCoordinatorStore from "./ForkCoordinatorStore.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project-a");
const threadId = ThreadId.make("coordinator-thread");
const record = {
  scope: `project:${projectId}`,
  projectId,
  generation: 1,
  threadId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access" as const,
};
const message = { commandId: CommandId.make("home-send-1"), text: "Plan the next change" };

const harness = (existing: boolean, scratch = true) => {
  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const claims: Array<string> = [];
  const dispatched: Array<{ readonly type: string; readonly orderKey?: string }> = [];
  const layer = ForkCoordinatorService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ForkCoordinatorStore.ForkCoordinatorStore)({
          get: () => Effect.succeed(existing ? record : null),
          claim: (input) => {
            claims.push(input.projectId);
            return Effect.succeed(record);
          },
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          ensureScratchProject: scratch
            ? Effect.succeed({ projectId: ProjectId.make("scratch") })
            : Effect.fail(
                new ManagedProjectFolders.ScratchUnavailableError({ baseDir: "/repo/.t3" }),
              ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId } as never),
          listPage: () =>
            Effect.succeed({
              projects: [
                { id: ProjectId.make("archived"), archivedAt: "2026-01-01T00:00:00.000Z" },
                { id: projectId, archivedAt: null },
              ] as never,
              nextCursor: null,
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({} as never);
          },
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ id: threadId, projectId, deletedAt: null, archivedAt: null } as never),
          dispatch: (command) => {
            dispatched.push(command as never);
            return Effect.succeed({} as never);
          },
          sendToThread: (input) => {
            sent.push(input);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
  return { launched, sent, claims, dispatched, layer };
};

const open = (layer: Layer.Layer<ForkCoordinatorService.ForkCoordinatorService>) =>
  Effect.gen(function* () {
    const service = yield* ForkCoordinatorService.ForkCoordinatorService;
    return yield* service.open({
      projectId,
      global: false,
      modelSelection: record.modelSelection,
      message,
    });
  }).pipe(Effect.provide(layer));

it.effect.each([
  ["a new", false],
  ["an existing", true],
] as const)("sends the home message to %s coordinator under its own command", ([, existing]) =>
  Effect.gen(function* () {
    const { launched, sent, dispatched, layer } = harness(existing);
    assert.strictEqual((yield* open(layer)).threadId, threadId);
    assert.deepStrictEqual(
      dispatched.map(({ type, orderKey }) => ({ type, orderKey })),
      [{ type: "thread.pin", orderKey: "b" }],
    );
    assert.strictEqual(launched.length, existing ? 0 : 1);
    assert.strictEqual(launched[0]?.initialMessage, undefined);
    assert.deepStrictEqual(
      sent.map(({ threadId, commandId, messageId, text, mode }) => ({
        threadId,
        commandId,
        messageId,
        text,
        mode,
      })),
      [
        {
          threadId,
          commandId: message.commandId,
          messageId: MessageId.make("message:home-send-1"),
          text: message.text,
          mode: "queue",
        },
      ],
    );
  }),
);

it.effect.each([
  ["the scratch workspace", true, "scratch"],
  // Scratch is off when the T3 home sits inside a Git repository.
  ["an open project when scratch is off", false, projectId],
] as const)("hosts the main coordinator in %s when no project is given", ([, scratch, host]) =>
  Effect.gen(function* () {
    const { claims, sent, dispatched, layer } = harness(false, scratch);
    yield* Effect.gen(function* () {
      const service = yield* ForkCoordinatorService.ForkCoordinatorService;
      return yield* service.open({ global: true, modelSelection: record.modelSelection, message });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(claims, [host]);
    assert.strictEqual(dispatched[0]?.orderKey, "ab");
    assert.strictEqual(sent[0]?.text, message.text);
  }),
);
