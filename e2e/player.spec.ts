import { test, expect } from "@playwright/test";

test("advances dialogue, saves, reloads and returns to title without stale panels", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("./");
  await expect(page.getByRole("button", { name: "New Game", exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "New Game", exact: true }).click();
  const dialogue = page.locator(".dialogue-text");
  await expect(dialogue).not.toHaveText(/Starting|^$/);
  // First click reveals; second must actually advance. Click the top of the
  // canvas so the dialogue overlay cannot intercept the click.
  const stage = page.locator(".stage-shell");
  await stage.click({ position: { x: 30, y: 30 } });
  const first = await dialogue.innerText();
  await stage.click({ position: { x: 30, y: 30 } });
  await expect(dialogue).not.toHaveText(first);
  await expect(dialogue).not.toHaveText("");
  await stage.click({ position: { x: 30, y: 30 } });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".backlog p")).toHaveCount(2);
  // The backlog contains the complete text, unlike the in-flight typewriter.
  const second = (await page.locator(".backlog p > span").last().innerText()).trim();
  expect(second).not.toBe(first);
  await page.locator(".close-button").click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".save-slot").first().click();
  await expect(page.locator(".panel")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 90_000 });
  await expect(dialogue).toHaveText(second);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Return to title", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Flowchart", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Story Flowchart" })).toBeVisible();
  await page.getByRole("button", { name: "Close Flowchart" }).click();
  if (info.project.name === "demo") {
    await stage.click({ position: { x: 30, y: 30 } });
    await expect(page.locator(".choice-list button")).toHaveCount(2);
    await page.locator(".choice-list button").first().click();
    await expect(dialogue).toContainText("vertical slice");
  }
  expect(errors).toEqual([]);
});
