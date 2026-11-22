import { describe, expect, it } from "vite-plus/test";

import { createForkLiveUpdateQueue } from "./forkLiveUpdateQueue.ts";

describe("fork live update queue", () => {
  it("skips builds for the installed head and coalesces commits received during a build", async () => {
    let head = "installed";
    let installed = head;
    const builds: string[] = [];
    const ready: string[] = [];
    const buildBases: Array<[string | null, string | null]> = [];
    const firstBuild = Promise.withResolvers<void>();
    const finishFirstBuild = Promise.withResolvers<void>();
    const update = createForkLiveUpdateQueue({
      signal: new AbortController().signal,
      readHead: async () => head,
      readInstalled: async () => installed,
      build: async (sha, previous, restartBase) => {
        builds.push(sha);
        buildBases.push([previous, restartBase]);
        if (sha === "first") {
          firstBuild.resolve();
          await finishFirstBuild.promise;
        }
        if (sha !== head) return null;
        installed = sha;
        return [sha];
      },
      onReady: (sha) => ready.push(sha),
      onFailure: async (error) => {
        throw error;
      },
    });

    await update();
    head = "first";
    const running = update();
    await firstBuild.promise;
    head = "middle";
    void update();
    head = "latest";
    void update();
    finishFirstBuild.resolve();
    await running;

    expect(builds).toEqual(["first", "latest"]);
    expect(ready).toEqual(["latest"]);
    expect(installed).toBe("latest");

    head = "one-more";
    await update();
    expect(buildBases).toEqual([
      ["installed", "installed"],
      ["installed", "installed"],
      ["latest", "installed"],
    ]);
  });

  it("keeps the installed commit on failure and tries again only after the branch changes", async () => {
    let installed = "previous";
    let head = "broken";
    const failures: unknown[] = [];
    const ready: string[] = [];
    const update = createForkLiveUpdateQueue({
      signal: new AbortController().signal,
      readHead: async () => head,
      readInstalled: async () => installed,
      build: async (sha) => {
        if (sha === "broken") throw new Error("build failed");
        installed = sha;
        return ["Repair the build"];
      },
      onReady: (sha) => ready.push(sha),
      onFailure: async (error) => {
        failures.push(error);
      },
    });

    await update();
    await update();
    expect(installed).toBe("previous");
    expect(failures).toHaveLength(1);
    expect(ready).toEqual([]);

    head = "fixed";
    await update();
    expect(installed).toBe("fixed");
    expect(ready).toEqual(["fixed"]);
  });
});
