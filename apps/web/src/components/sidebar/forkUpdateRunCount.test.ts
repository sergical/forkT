import { expect, it } from "vite-plus/test";

import { countForkUpdateRuns } from "./forkUpdateRunCount";

it("counts active runs once and excludes idle, queued and completed work", () => {
  expect(
    countForkUpdateRuns([
      { status: "running", activityRunStatus: "running" },
      { status: "starting" },
      { status: "waiting" },
      { status: "queued", activityRunStatus: "running" },
      { status: "queued" },
      { status: "idle" },
      { status: "completed" },
    ]),
  ).toBe(4);
});
