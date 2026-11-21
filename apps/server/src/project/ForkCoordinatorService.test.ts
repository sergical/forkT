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

const harness = (existing: boolean) => {
  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const layer = ForkCoordinatorService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ForkCoordinatorStore.ForkCoordinatorStore)({
          get: () => Effect.succeed(existing ? record : null),
          claim: () => Effect.succeed(record),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId } as never),
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
          sendToThread: (input) => {
            sent.push(input);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
  return { launched, sent, layer };
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
    const { launched, sent, layer } = harness(existing);
    assert.strictEqual((yield* open(layer)).threadId, threadId);
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
