import { test, expect } from "@playwright/test";
import path from "node:path";
import { createHash } from "node:crypto";
import { SnapshotStore } from "../../src/lib/storage/snapshots";
import { fixtureSnapshot, FIXTURE_SOURCES, SNAPSHOT_ID, COMMIT } from "../helpers/fixtures";
import { sourceLines } from "../../src/lib/contracts/repository";

test.beforeEach(() => {
  // Explicit test data lives in an isolated database, never in the normal workspace.
  const store = new SnapshotStore(path.join(process.env.ABSTRACT_DATA_DIR!, "abstract.sqlite"));
  const snapshot = fixtureSnapshot();
  store.deleteSnapshot(snapshot.id);
  store.saveSnapshot(snapshot);
  for (const file of snapshot.files) {
    const content = FIXTURE_SOURCES[file.path];
    if (content !== undefined)
      store.saveSource({
        snapshotId: snapshot.id,
        fileId: file.id,
        path: file.path,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        lineCount: sourceLines(content).length,
      });
  }
  store.close();
});

test("home is readable, responsive, and honest about upcoming features", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Every codebase has a story." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "GitHub repository URL" })).toBeVisible();
  await expect(page.getByText("AVAILABLE NOW", { exact: true })).toBeVisible();
  await page.getByText("How it works", { exact: true }).click();
  await expect(page.getByText(/Nothing from the repository is executed/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("home.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("restores source, selects an immutable line, filters files, and reports exclusions", async ({
  page,
}, testInfo) => {
  await page.goto(`/?snapshot=${SNAPSHOT_ID}`);
  await expect(
    page.getByRole("heading", { name: "fixture-owner / booking-fixture" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText(
    "A deliberately small test repository.",
  );
  await page.getByRole("button", { name: "Select line 1", exact: true }).click();
  await expect(page).toHaveURL(/#L1$/);
  await expect(
    page.getByRole("link", { name: "Open this file at the pinned commit on GitHub" }),
  ).toHaveAttribute("href", new RegExp(`/blob/${COMMIT}/README.md#L1$`));
  await page.getByRole("textbox", { name: "Filter files by path" }).fill("page.tsx");
  await page.getByRole("button", { name: "src/app/page.tsx", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText("Book a venue");
  await page.getByRole("button", { name: "src/app/page.tsx", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText("Book a venue");
  await page.getByRole("tab", { name: /Coverage/ }).click();
  await page.getByRole("combobox", { name: "Filter by file status" }).selectOption("skipped");
  await expect(page.getByRole("table")).toContainText(".env.local");
  await expect(page.getByRole("table")).toContainText(
    "Environment, credential, or key file excluded.",
  );
  await page.getByRole("button", { name: ".env.local", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText(
    "A little privacy by design.",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });
});

test("invalid repository URLs receive real local API validation", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "GitHub repository URL" })
    .fill("https://example.com/owner/repo");
  await page.getByRole("button", { name: "Open repository", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("repository root URL");
  await expect(page.getByRole("button", { name: "Open repository", exact: true })).toBeEnabled();
});

test("handles streamed import progress and final source navigation", async ({ page }) => {
  const store = new SnapshotStore(path.join(process.env.ABSTRACT_DATA_DIR!, "abstract.sqlite"));
  const snapshot = store.getSnapshot(SNAPSHOT_ID)!;
  store.close();
  // Only the GitHub import boundary is mocked; snapshot and source reads use real local APIs.
  await page.route("**/api/repositories", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          JSON.stringify({ type: "progress", stage: "fetching", message: "Reading fixture tree…" }),
          JSON.stringify({ type: "complete", snapshot }),
        ].join("\n") + "\n",
    });
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "GitHub repository URL" })
    .fill("https://github.com/fixture-owner/booking-fixture");
  await page.getByRole("button", { name: "Open repository", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "fixture-owner / booking-fixture" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText(
    "Booking fixture",
  );
});

test("deletes a snapshot and its source through the local API", async ({ page }) => {
  await page.goto(`/?snapshot=${SNAPSHOT_ID}`);
  await page.getByRole("tab", { name: "Snapshot overview" }).click();
  await page.getByRole("button", { name: "Remove snapshot", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every codebase has a story." })).toBeVisible();
  const response = await page.request.get(`/api/snapshots/${SNAPSHOT_ID}`);
  expect(response.status()).toBe(404);
});
