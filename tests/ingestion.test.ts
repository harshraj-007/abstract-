import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SnapshotStore } from "@/lib/storage/snapshots";
import { GitHubClient } from "@/lib/github/client";
import { ingestRepository, loadSource } from "@/lib/github/ingest";
import { coverageOf, type ImportEvent } from "@/lib/contracts/repository";
import {
  blobFor,
  COMMIT,
  FIXTURE_SOURCES,
  fixtureSnapshot,
  fixtureTree,
  mockGitHubFetch,
} from "./helpers/fixtures";

let store: SnapshotStore;
beforeEach(() => {
  store = new SnapshotStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("snapshot ingestion and on-demand source", () => {
  it("pins one commit, persists the manifest and downloads only opened files", async () => {
    const fetcher = vi.fn(mockGitHubFetch());
    const client = new GitHubClient({ fetch: fetcher as typeof fetch });
    const events: ImportEvent[] = [];
    const snapshot = await ingestRepository(
      "https://github.com/fixture-owner/booking-fixture",
      client,
      store,
      (event) => events.push(event),
    );
    expect(snapshot.commit).toBe(COMMIT);
    expect(events.map((event) => event.type === "progress" && event.stage)).toEqual([
      "resolving",
      "fetching",
      "indexing",
      "saving",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(coverageOf(snapshot)).toMatchObject({
      discovered: 7,
      selected: 4,
      fetched: 0,
      skipped: 3,
    });
    expect(fetcher.mock.calls[2][0].toString()).toContain("b".repeat(40));
    const file = snapshot.files.find((file) => file.path === "src/app/page.tsx")!;
    const first = await loadSource(snapshot.id, file.id, client, store);
    expect(first.source.content).toBe(FIXTURE_SOURCES[file.path]);
    expect(first.cached).toBe(false);
    expect(coverageOf(first.snapshot).fetched).toBe(1);
    const second = await loadSource(snapshot.id, file.id, client, store);
    expect(second.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("cannot fetch an excluded file or a source outside the manifest", async () => {
    const snapshot = fixtureSnapshot();
    store.saveSnapshot(snapshot);
    const fetcher = vi.fn(mockGitHubFetch());
    const client = new GitHubClient({ fetch: fetcher as typeof fetch });
    const sensitive = snapshot.files.find((file) => file.path === ".env.local")!;
    await expect(loadSource(snapshot.id, sensitive.id, client, store)).rejects.toMatchObject({
      code: "FILE_EXCLUDED",
    });
    await expect(loadSource(snapshot.id, "not-in-manifest", client, store)).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks incomplete discovery instead of claiming full coverage", async () => {
    const client = new GitHubClient({
      fetch: mockGitHubFetch({ truncated: true }) as typeof fetch,
    });
    const snapshot = await ingestRepository(
      "https://github.com/fixture-owner/booking-fixture",
      client,
      store,
    );
    expect(snapshot.discoveryComplete).toBe(false);
    expect(snapshot.limitations.join(" ")).toContain("truncated");
  });

  it("rejects private repositories even when a configured token can access them", async () => {
    const fetcher = vi.fn(mockGitHubFetch({ private: true }));
    await expect(
      ingestRepository(
        "https://github.com/fixture-owner/booking-fixture",
        new GitHubClient({ fetch: fetcher as typeof fetch }),
        store,
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_REPOSITORY" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.recent()).toHaveLength(0);
  });

  it("records a failed source fetch and permits a later retry", async () => {
    const snapshot = fixtureSnapshot();
    store.saveSnapshot(snapshot);
    const file = snapshot.files.find((file) => file.path === "README.md")!;
    const failing = new GitHubClient({
      fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
    });
    await expect(loadSource(snapshot.id, file.id, failing, store)).rejects.toMatchObject({
      code: "GITHUB_ERROR",
    });
    expect(
      store.getSnapshot(snapshot.id)?.files.find((entry) => entry.id === file.id)?.status,
    ).toBe("failed");
    expect(store.getSource(snapshot.id, file.id)).toBeNull();
    const retry = await loadSource(
      snapshot.id,
      file.id,
      new GitHubClient({ fetch: mockGitHubFetch() as typeof fetch }),
      store,
    );
    expect(retry.snapshot.files.find((entry) => entry.id === file.id)?.status).toBe("fetched");
  });

  it("does not persist a downloaded credential and updates its coverage reason", async () => {
    const snapshot = fixtureSnapshot();
    const content = "-----BEGIN PRIVATE KEY-----";
    const blob = blobFor(content);
    const file = snapshot.files.find((file) => file.path === "README.md")!;
    file.sha = blob.sha;
    file.size = blob.size;
    store.saveSnapshot(snapshot);
    const client = new GitHubClient({ fetch: (async () => Response.json(blob)) as typeof fetch });
    await expect(loadSource(snapshot.id, file.id, client, store)).rejects.toMatchObject({
      code: "SENSITIVE_SOURCE",
    });
    expect(store.getSource(snapshot.id, file.id)).toBeNull();
    expect(
      store.getSnapshot(snapshot.id)?.files.find((entry) => entry.id === file.id),
    ).toMatchObject({ status: "skipped", reason: "sensitive" });
  });

  it("handles an empty repository explicitly", async () => {
    await expect(
      ingestRepository(
        "https://github.com/fixture-owner/booking-fixture",
        new GitHubClient({ fetch: mockGitHubFetch({ tree: [] }) as typeof fetch }),
        store,
      ),
    ).rejects.toMatchObject({ code: "EMPTY_REPOSITORY" });
  });

  it("never fetches source during manifest discovery", async () => {
    const tree = fixtureTree();
    tree.push({
      path: "src/instructions.ts",
      type: "blob",
      mode: "100644",
      sha: "c".repeat(40),
      size: 50,
    });
    const fetcher = vi.fn(mockGitHubFetch({ tree }));
    await ingestRepository(
      "https://github.com/fixture-owner/booking-fixture",
      new GitHubClient({ fetch: fetcher as typeof fetch }),
      store,
    );
    expect(fetcher.mock.calls.every(([input]) => !input.toString().includes("/blobs/"))).toBe(true);
  });
});

describe("durable local storage", () => {
  it("restores snapshots after reopening SQLite and deletes their saved source", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "abstract-storage-"));
    const filename = path.join(directory, "state.sqlite");
    const first = new SnapshotStore(filename);
    const snapshot = fixtureSnapshot();
    const file = snapshot.files[0];
    first.saveSnapshot(snapshot);
    first.saveSource({
      snapshotId: snapshot.id,
      fileId: file.id,
      path: file.path,
      content: "fixture",
      contentHash: "test-hash",
      lineCount: 1,
    });
    first.close();
    const reopened = new SnapshotStore(filename);
    try {
      expect(reopened.recent()).toHaveLength(1);
      expect(reopened.getSnapshot(snapshot.id)?.commit).toBe(COMMIT);
      expect(reopened.getSource(snapshot.id, file.id)?.content).toBe("fixture");
      reopened.deleteSnapshot(snapshot.id);
      expect(reopened.getSnapshot(snapshot.id)).toBeNull();
      expect(reopened.getSource(snapshot.id, file.id)).toBeNull();
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
