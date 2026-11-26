import {
  CommandId,
  ForkCoordinatorError,
  MessageId,
  type ProjectId,
  type OrchestratorMcpTaskRole,
  type ModelSelection,
  type ThreadId,
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
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ForkCoordinatorStore from "./ForkCoordinatorStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

import * as Clock from "effect/Clock";
import { recommendForkRoute, refreshForkRoutingProviders } from "./forkCoordinatorRouting.ts";

type Handoff = {
  readonly senderThreadId: ThreadId;
  readonly role?: OrchestratorMcpTaskRole | undefined;
  readonly highJudgment?: boolean | undefined;
};

export class ForkCoordinatorService extends Context.Service<
  ForkCoordinatorService,
  {
    readonly open: (
      input: ForkCoordinatorOpenInput,
      handoff?: Handoff,
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
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const ensure = Effect.fn("ForkCoordinatorService.ensure")(function* (
      input: ForkCoordinatorOpenInput & { readonly projectId: ProjectId },
    ) {
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
        if (shell.settledAt != null || shell.settledOverride === "settled") {
          yield* threads.dispatch({
            type: "thread.unsettle",
            commandId: CommandId.make(
              `restore-active:${shell.id}:${DateTime.toEpochMillis(shell.updatedAt)}`,
            ),
            threadId: shell.id,
            reason: "user",
          });
        }
        if (shell.snoozedUntil != null) {
          yield* threads.dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(
              `restore-awake:${shell.id}:${DateTime.toEpochMillis(shell.updatedAt)}`,
            ),
            threadId: shell.id,
            reason: "user",
          });
        }
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
      const routingInput = {
        providers: available,
        settings,
        projectId: input.projectId,
        highJudgment: true,
        defaultSelection:
          input.modelSelection ??
          settings.defaultModelSelection ??
          existing?.modelSelection ??
          null,
        fallbackSelection: settings.fallbackModelSelection,
        ...(input.modelSelection === undefined
          ? {}
          : {
              target: {
                providerInstanceId: input.modelSelection.instanceId,
                model: input.modelSelection.model,
              },
            }),
      };
      const routing =
        settings.forkCoordinatorRouting === undefined
          ? undefined
          : recommendForkRoute({
              ...routingInput,
              providers: yield* refreshForkRoutingProviders(providers, routingInput),
              now: yield* Clock.currentTimeMillis,
            });
      if (routing?.selection === null)
        return yield* new ForkCoordinatorError({ message: routing.reason });
      const first = available.find(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.auth.status !== "unauthenticated" &&
          provider.models.length > 0,
      );
      const modelSelection =
        routing?.selection ??
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
        title: input.global ? "forkT · Main coordinator" : "forkT · Project coordinator",
        modelSelection: claimed.modelSelection,
        runtimeMode: claimed.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "web",
      });
      return {
        projectId: claimed.projectId,
        global: input.global,
        threadId: claimed.threadId,
        ...(routing === undefined ? {} : { routing }),
      };
    });
    const open = Effect.fn("ForkCoordinatorService.open")(
      function* (input: ForkCoordinatorOpenInput, handoff?: Handoff) {
        const projectId =
          input.projectId ??
          (input.global
            ? yield* folders.ensureScratchProject.pipe(
                Effect.map((scratch) => scratch.projectId),
                // Scratch is off when the T3 home sits inside a Git repository; any project can host.
                Effect.catchTags({
                  ScratchUnavailableError: () =>
                    projects
                      .listPage({ cursor: 0, limit: 100 })
                      .pipe(
                        Effect.map(
                          (page) => page.projects.find((project) => project.archivedAt == null)?.id,
                        ),
                      ),
                }),
              )
            : undefined);
        if (projectId === undefined)
          return yield* new ForkCoordinatorError({
            message: "Choose a project for its coordinator.",
          });
        const coordinator = yield* ensure({ ...input, projectId });
        let routing: ForkCoordinator["routing"] = coordinator.routing;
        // Delivered under its own command, never the launch's, so a retry replays it and
        // concurrent first sends each land.
        if (input.message !== undefined) {
          let selection: ModelSelection | undefined = handoff && input.modelSelection;
          if (handoff !== undefined && !(yield* threads.hasReceipt(input.message.commandId))) {
            const settings = yield* settingsService.getSettings;
            if (settings.forkCoordinatorRouting !== undefined) {
              const destination = yield* threads.getThreadShell(coordinator.threadId);
              if (destination === null) {
                return yield* new ForkCoordinatorError({
                  message: "The project coordinator was not found.",
                });
              }
              const projectSettings = resolveProjectSettings(
                settings,
                coordinator.projectId,
              ).settings;
              const pin = input.modelSelection;
              const routingInput = {
                providers: yield* providers.getProviders,
                projectId: coordinator.projectId,
                settings,
                role: handoff.role,
                highJudgment: handoff.highJudgment,
                defaultSelection: pin ?? destination.modelSelection,
                fallbackSelection: projectSettings.fallbackModelSelection,
                target: pin && { providerInstanceId: pin.instanceId, model: pin.model },
              };
              const route = recommendForkRoute({
                ...routingInput,
                providers: yield* refreshForkRoutingProviders(providers, routingInput),
                now: yield* Clock.currentTimeMillis,
              });
              if (route.selection === null)
                return yield* new ForkCoordinatorError({ message: route.reason });
              routing = route;
              selection = route.selection;
            }
          }
          yield* threads.sendToThread({
            projectId: coordinator.projectId,
            commandId: input.message.commandId,
            threadId: coordinator.threadId,
            messageId: MessageId.make(`message:${input.message.commandId}`),
            text: input.message.text,
            attachments: [],
            mode: "queue",
            createdBy: handoff === undefined ? "user" : "agent",
            creationSource: handoff === undefined ? "web" : "mcp",
            ...(handoff && { senderThreadId: handoff.senderThreadId }),
            ...(selection && { modelSelection: selection }),
          });
        }
        return routing ? { ...coordinator, routing } : coordinator;
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
