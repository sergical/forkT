import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "T3 fork: home opens the main coordinator, whose onboarding sends the first message",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await t3.open("/");

    await expect(browser).toHaveURL(/fork%3Aglobal%3A/, { timeout: 20_000 });
    await expect(screen.getByText("Hey, I'm your coordinator", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await screen.getByRole("button", "Skip, let me work").tap({ timeout: 30_000 });
    await app.screenshot("onboarding-starters");

    await screen.getByRole("button", "Catch me up on my projects").tap({ timeout: 20_000 });
    await expect(screen.getByText("Catch me up on my projects.")).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("button", "Skip, let me work")).toHaveCount(0);
  },
);
