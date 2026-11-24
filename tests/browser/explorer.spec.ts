import { test, expect } from "@playwright/test";
import path from "node:path";
import { createHash } from "node:crypto";
import { SnapshotStore } from "../../src/lib/storage/snapshots";
import { fixtureSnapshot, FIXTURE_SOURCES, SNAPSHOT_ID, COMMIT } from "../helpers/fixtures";
import { sourceLines } from "../../src/lib/contracts/repository";
import { analysisFixture, LEARNING_REPO } from "../helpers/analysis-fixtures";
import { analyzeSnapshot } from "../../src/lib/analysis/analyze";
import { OverviewService } from "../../src/lib/ai/service";
import { QuestionService } from "../../src/lib/ai/questions";

test("restores an explicitly seeded question and preserves its scope while following citations", async ({
  page,
}) => {
  const store = new SnapshotStore(path.join(process.env.ABSTRACT_DATA_DIR!, "abstract.sqlite"));
  const { snapshot, sources } = analysisFixture(LEARNING_REPO);
  store.deleteSnapshot(snapshot.id);
  store.saveSnapshot(snapshot);
  sources.forEach((source) => store.saveSource(source));
  const service = new QuestionService({
    env: () => ({ GEMINI_API_KEY: "test-only-placeholder", GEMINI_MODEL: "gemini-fixture" }),
    provider: () => ({
      generate: async (input) => {
        const id = JSON.parse(input.evidence).evidence[0].id;
        const claim = {
          text: "Explicit question fixture; no live Gemini response.",
          status: "observed",
          evidenceIds: [id],
          limitation: "",
        };
        return {
          output: {
            answer: claim,
            steps: [],
            takeaway: claim,
            concepts: [],
            limitations: ["Browser fixture only."],
          },
          usage: {},
        };
      },
    }),
  });
  const draft = {
    question: "Explain Home and Widget",
    fileId: snapshot.files.find((file) => file.path === "src/app/page.tsx")!.id,
    depth: "learn" as const,
  };
  const preview = await service.preview(snapshot.id, store, draft);
  await service.answer(snapshot.id, store, draft, {
    evidenceFingerprint: preview.evidenceFingerprint!,
  });
  store.close();
  const answerRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/questions") &&
      request.method() === "POST" &&
      request.postDataJSON()?.action === "answer"
    )
      answerRequests.push(request.url());
  });
  await page.goto(`/?snapshot=${snapshot.id}`);
  await page.getByRole("tab", { name: "Ask code", exact: true }).click();
  await page.getByRole("button", { name: /Explain Home and Widget src\/app\/page/ }).click();
  await expect(page.getByRole("heading", { name: draft.question, exact: true })).toBeVisible();
  await expect(page.getByLabel("Focus line")).toHaveValue("");
  await page
    .getByRole("button", { name: /^src\/app\/page.tsx/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#L1$/);
  await page.getByRole("tab", { name: "Ask code", exact: true }).click();
  await expect(page.getByLabel("Your question")).toHaveValue(draft.question);
  await expect(page.getByLabel("Focus line")).toHaveValue("");
  await expect(page.getByRole("heading", { name: draft.question, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview cached context", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Context for this question" })).toBeVisible();
  await page.getByLabel("Focus line").fill("2");
  await expect(page.getByRole("heading", { name: "Context for this question" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview cached context", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Context for this question" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(answerRequests).toEqual([]);
});

test("restores an explicitly seeded fixture overview and follows source citations without a model call", async ({
  page,
}, testInfo) => {
  const store = new SnapshotStore(path.join(process.env.ABSTRACT_DATA_DIR!, "abstract.sqlite"));
  const { snapshot, sources } = analysisFixture(LEARNING_REPO);
  store.deleteSnapshot(snapshot.id);
  store.saveSnapshot(snapshot);
  for (const source of sources) store.saveSource(source);
  store.saveAnalysis(analyzeSnapshot(snapshot, sources));
  // Only the isolated test database receives this labelled provider fixture.
  const service = new OverviewService({
    env: () => ({ GEMINI_API_KEY: "test-only-placeholder", GEMINI_MODEL: "gemini-fixture" }),
    provider: () => ({
      generate: async (input) => {
        const excerpts = JSON.parse(input.evidence).evidence as { id: string; path: string }[];
        const id = excerpts.find((item) => item.path === "src/app/page.tsx")!.id;
        const claim = {
          text: "Explicit fixture overview; no live Gemini response.",
          status: "observed" as const,
          evidenceIds: [id],
          limitation: "",
        };
        return {
          output: {
            purpose: claim,
            stack: [],
            modules: [],
            architecture: [],
            readingOrder: [{ evidenceId: id, reason: claim }],
            concepts: [],
            limitations: ["This output is an explicit browser test fixture."],
          },
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    }),
  });
  const state = await service.getState(snapshot.id, store);
  await service.generate(snapshot.id, store, { evidenceFingerprint: state.evidenceFingerprint! });
  store.close();
  await page.goto(`/?snapshot=${snapshot.id}`);
  await page.getByRole("tab", { name: "AI overview", exact: true }).click();
  const overview = page.getByRole("tabpanel", { name: "AI overview", exact: true });
  await expect(overview.getByRole("heading", { name: "The core idea", exact: true })).toBeVisible();
  await expect(overview).toContainText("Explicit fixture overview; no live Gemini response.");
  await expect(overview).toContainText("100 input tokens");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("ai-overview-fixture.png"), fullPage: true });
  await overview
    .getByRole("button", { name: /^src\/app\/page\.tsx/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#L1$/);
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText("<Widget />");
});

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
  await expect(page.getByText("AVAILABLE NOW", { exact: true })).toHaveCount(2);
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

test("explains when the browser cannot reach the local import endpoint", async ({ page }) => {
  await page.route("**/api/repositories", async (route) => {
    if (route.request().method() === "POST") await route.abort("connectionrefused");
    else await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "GitHub repository URL" })
    .fill("https://github.com/gdg-da/SBG_Website");
  await page.getByRole("button", { name: "Open repository", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Cannot connect to the local Abstract server",
  );
  await expect(page.getByRole("alert")).toContainText("keep that terminal open");
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

test("builds a real cached-source map and opens graph and entry-point evidence", async ({
  page,
}, testInfo) => {
  const { snapshot, sources } = analysisFixture(LEARNING_REPO);
  const store = new SnapshotStore(path.join(process.env.ABSTRACT_DATA_DIR!, "abstract.sqlite"));
  store.deleteSnapshot(snapshot.id);
  store.saveSnapshot(snapshot);
  for (const source of sources) store.saveSource(source);
  store.close();
  await page.goto(`/?snapshot=${snapshot.id}`);
  await page.getByRole("tab", { name: "Architecture map", exact: true }).click();
  await page.getByRole("button", { name: "Use downloaded source", exact: true }).click();
  await expect(page.getByText("8 source files parsed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^src\/app\/page\.tsx/ }).click();
  await expect(
    page.getByRole("group", { name: "Source dependency map for src/app/page.tsx", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open src/components/widget.tsx at line 1", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText('"use client"');
  await expect(page).toHaveURL(/#L1$/);
  await page.getByRole("tab", { name: "Architecture map", exact: true }).click();
  await page.getByRole("tab", { name: /^Entry points/ }).click();
  const entries = page.getByRole("tabpanel", { name: /^Entry points/ });
  await expect(entries).toContainText("/users/[id]");
  await entries.getByRole("button", { name: /^src\/app\/api\/users\/route\.ts/ }).click();
  await expect(page).toHaveURL(/#L2$/);
  await expect(page.getByRole("region", { name: "Source viewer" })).toContainText(
    "export async function GET",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("tab", { name: "Architecture map", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("architecture.png"), fullPage: true });
});
