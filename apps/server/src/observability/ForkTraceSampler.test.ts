import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import * as ForkTraceSampler from "./ForkTraceSampler.ts";

const ms = (value: number) => BigInt(value) * 1_000_000n;
const ok = Exit.void;
const failed = Exit.failCause(Cause.fail("boom"));

const harness = (random = () => 1, spanAttributes?: Readonly<Record<string, unknown>>) => {
  const sent: Array<string> = [];
  const exportedAttributes = new Map<string, unknown>();
  const delegate = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        sent.push(options.name);
        for (const [key, value] of span.attributes) exportedAttributes.set(key, value);
        end(endTime, exit);
      };
      return span;
    },
  });
  const tracer = ForkTraceSampler.make(
    delegate,
    { ...ForkTraceSampler.defaultForkTracePolicy, ...(spanAttributes ? { spanAttributes } : {}) },
    random,
  );
  const start = (name: string, at: number, parent?: Tracer.Span) =>
    tracer.span({
      name,
      parent: parent === undefined ? Option.none() : Option.some(parent),
      annotations: Context.empty(),
      links: [],
      startTime: ms(at),
      kind: "internal",
      root: parent === undefined,
      sampled: true,
    });
  return { sent, start, exportedAttributes };
};

describe("ForkTraceSampler", () => {
  it("exports release attribution on kept commands", () => {
    const release = "t3-fork@0.1.13-fork.20261125.5245";
    const commit = "22a39c4dda88a39e0903da6058961e0157ad173f";
    const { exportedAttributes, start } = harness(() => 1, {
      "sentry.release": release,
      "t3.build.commit": commit,
    });
    start("ws.rpc.forkCoordinator.open", 0).end(ms(2), ok);
    assert.strictEqual(exportedAttributes.get("sentry.release"), release);
    assert.strictEqual(exportedAttributes.get("t3.build.commit"), commit);
  });

  it("drops a fast, successful trace and sends nothing from it", () => {
    const { sent, start } = harness();
    const root = start("ws.rpc.projects.readFile", 0);
    start("sqlite", 1, root).end(ms(30), ok);
    root.end(ms(40), ok);
    assert.deepStrictEqual(sent, []);
  });

  it("keeps a slow trace without its sub-10ms spans", () => {
    const { sent, start } = harness();
    const root = start("ws.rpc.vcs.refreshStatus", 0);
    start("sqlite", 1, root).end(ms(2), ok);
    start("runGitCommand", 3, root).end(ms(350), ok);
    root.end(ms(400), ok);
    assert.deepStrictEqual(sent, ["runGitCommand", "ws.rpc.vcs.refreshStatus"]);
  });

  it("keeps a failed trace, its failure, and the short parents leading to it", () => {
    const { sent, start } = harness();
    const root = start("ws.rpc.filesystem.getMetadata", 0);
    const parent = start("WorkspacePaths.resolve", 1, root);
    start("FileSystem.stat", 1, parent).end(ms(2), failed);
    start("sqlite", 2, root).end(ms(3), ok);
    parent.end(ms(3), failed);
    root.end(ms(4), ok);
    assert.deepStrictEqual(sent, [
      "FileSystem.stat",
      "WorkspacePaths.resolve",
      "ws.rpc.filesystem.getMetadata",
    ]);
  });

  it("always keeps user commands, but not their polling subtrees", () => {
    const { sent, start } = harness();
    const root = start("ws.rpc.orchestration.dispatchCommand", 0);
    const poll = start("ClaudeAgentSdkQueryRunner.trackDescendants", 1, root);
    start("processRunner.runProcessCore", 1, poll).end(ms(60), ok);
    poll.end(ms(61), ok);
    start("orchestrationV2.EventSink.write", 62, root).end(ms(80), ok);
    root.end(ms(90), ok);
    assert.deepStrictEqual(sent, [
      "orchestrationV2.EventSink.write",
      "ws.rpc.orchestration.dispatchCommand",
    ]);
  });

  it("streams a long-lived trace: only slow and failed spans, then the ancestors that hold them", () => {
    const { sent, start } = harness();
    const session = start("ws.rpc.subscribeVcsStatus", 0);
    const refresh = start("VcsStatus.refresh", 40_000, session);
    start("runGitCommand", 40_000, refresh).end(ms(40_010), ok);
    start("runGitCommand", 40_010, refresh).end(ms(40_900), ok);
    refresh.end(ms(40_901), ok);
    start("runGitCommand", 41_000, session).end(ms(41_005), ok);
    session.end(ms(90_000), Exit.interrupt());
    assert.deepStrictEqual(sent, [
      "runGitCommand",
      "VcsStatus.refresh",
      "ws.rpc.subscribeVcsStatus",
    ]);
  });

  it("sends a failure that ends after its trace was decided", () => {
    const { sent, start } = harness();
    const root = start("ws.rpc.forkCoordinator.open", 0);
    const detached = start("ThreadManagementService.sendToThread", 1, root);
    root.end(ms(5), ok);
    start("FileSystem.stat", 6, detached).end(ms(7), failed);
    detached.end(ms(8), failed);
    assert.deepStrictEqual(sent, [
      "ws.rpc.forkCoordinator.open",
      "FileSystem.stat",
      "ThreadManagementService.sendToThread",
    ]);
  });

  it("samples a baseline of ordinary traces", () => {
    const { sent, start } = harness(() => 0);
    const root = start("ws.rpc.projects.readFile", 0);
    root.end(ms(5), ok);
    assert.deepStrictEqual(sent, ["ws.rpc.projects.readFile"]);
  });
});
