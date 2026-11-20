import {
  CommandId,
  ForkCoordinatorError,
  type ForkCoordinator,
  type ForkCoordinatorOpenInput,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "./ProjectService.ts";
import * as ForkCoordinatorStore from "./ForkCoordinatorStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

export class ForkCoordinatorService extends Context.Service<
  ForkCoordinatorService,
  {
    readonly open: (
      input: ForkCoordinatorOpenInput,
    ) => Effect.Effect<ForkCoordinator, ForkCoordinatorError>;
  }
>()("t3/project/ForkCoordinatorService") {}

const isCoordinatorError = Schema.is(ForkCoordinatorError);
export const layer = Layer.effect(
  ForkCoordinatorService,
  Effect.gen(function* () {
    const store = yield* ForkCoordinatorStore.ForkCoordinatorStore;
    const projects = yield* ProjectService.ProjectService;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const launches = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const open = Effect.fn("ForkCoordinatorService.open")(
      function* (input: ForkCoordinatorOpenInput) {
        const existing = yield* store.get(input);
        const shell = existing === null ? null : yield* threads.getThreadShell(existing.threadId);
        if (existing !== null && shell !== null && shell.deletedAt === null) {
          if (shell.archivedAt !== null)
            yield* threads.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(
                `reopen:${shell.id}:${DateTime.toEpochMillis(shell.archivedAt)}`,
              ),
              threadId: shell.id,
            });
          return {
            projectId: existing.projectId,
            global: input.global,
            threadId: existing.threadId,
          };
        }
        const project = yield* projects.getById(input.projectId);
        if (Option.isNone(project))
          return yield* new ForkCoordinatorError({ message: "The project was not found." });
        const settings = resolveProjectSettings(
          yield* settingsService.getSettings,
          input.projectId,
          project.value,
        ).settings;
        const available = yield* providers.getProviders;
        const first = available.find(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.auth.status !== "unauthenticated" &&
            provider.models.length > 0,
        );
        const modelSelection =
          input.modelSelection ??
          settings.defaultModelSelection ??
          (available.some(
            (provider) =>
              provider.instanceId === existing?.modelSelection.instanceId &&
              provider.enabled &&
              provider.installed,
          )
            ? existing?.modelSelection
            : undefined) ??
          (first?.models[0] ? { instanceId: first.instanceId, model: first.models[0].slug } : null);
        if (modelSelection === null)
          return yield* new ForkCoordinatorError({
            message: "Configure a provider in Settings before opening a coordinator.",
          });
        const claimed = yield* store.claim({
          ...input,
          modelSelection,
          runtimeMode: settings.defaultRuntimeMode,
        });
        yield* launches.launch({
          commandId: CommandId.make(`open:${claimed.threadId}`),
          threadId: claimed.threadId,
          projectId: claimed.projectId,
          title: input.global ? "T3 fork · Main coordinator" : "T3 fork · Project coordinator",
          modelSelection: claimed.modelSelection,
          runtimeMode: claimed.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
        });
        return { projectId: claimed.projectId, global: input.global, threadId: claimed.threadId };
      },
      Effect.mapError((error) =>
        isCoordinatorError(error)
          ? error
          : new ForkCoordinatorError({
              message:
                "Could not open the coordinator. Check the project's provider settings and try again.",
            }),
      ),
    );
    return ForkCoordinatorService.of({ open });
  }),
);
