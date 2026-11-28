import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A project’s unread dot explains the result and opens the folder",
  WEB,
  async ({ t3, browser, screen }) => {
    const thread = await t3.thread({
      project: await t3.project("Shipments"),
      title: "Packing list",
      messages: ["Check the packing list."],
    });
    await t3.open("/inbox");
    const folder = screen.getByRole("button", /^Shipments\b/);
    await expect(folder).toHaveAttribute("aria-expanded", "true");

    // Aim before hover reveals the neighboring new-thread button, as a pointer user would.
    const point = await browser.evaluate(() => {
      const dot = document.querySelector('[data-testid="sidebar-project-folder"] .bg-success');
      if (!dot) throw new Error("The completed thread has no folder indicator.");
      const box = dot.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await browser.mouse.move(point.x, point.y);
    await browser.mouse.down();
    await browser.mouse.up();
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await expect(browser).toHaveURL(/\/inbox$/);

    await browser.keyboard.press("Tab");
    await browser.keyboard.press("Shift+Tab");
    const hint = await browser.evaluate(
      () => document.activeElement?.getAttribute("aria-description") ?? "",
    );
    if (!hint) throw new Error("Keyboard focus did not expose the unread status.");
    await expect(screen.getByText(hint)).toBeVisible();
    await browser.keyboard.press("Enter");
    await screen.getByRole("button", "Show threads").tap();
    await screen.getByRole("button", /^Packing list, Done/).tap();
    await expect(browser).toHaveURL(new RegExp(encodeURIComponent(thread.threadId) + "$"));
    await screen.getByRole("button", "Hide threads").tap();
    await expect(screen.getByRole("button", "Shipments", { exact: true })).toBeVisible();
  },
);
