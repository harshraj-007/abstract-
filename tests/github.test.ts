import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseRepositoryUrl } from "@/lib/github/url";
import {
  classifyEntry,
  containsLikelySecret,
  selectManifest,
  type TreeEntry,
} from "@/lib/github/filter";
import { GitHubClient } from "@/lib/github/client";
import { sourceUrl } from "@/lib/contracts/repository";
import { COMMIT, blobFor } from "./helpers/fixtures";

describe("repository URL boundary", () => {
  it.each(["https://github.com/owner/project", " https://github.com/owner/project.git/ "])(
    "accepts a repository root: %s",
    (input) => {
      expect(parseRepositoryUrl(input)).toEqual({ owner: "owner", name: "project" });
    },
  );
  it.each([
    "owner/project",
    "http://github.com/owner/project",
    "https://github.com.evil.test/owner/project",
    "https://github.com@evil.test/owner/project",
    "https://token@github.com/owner/project",
    "https://github.com/owner/project/tree/main",
    "https://github.com/owner/project?token=example",
    "https://github.com/owner/project#readme",
    "https://github.com/owner/../project",
    "https://github.com/owner/%2e%2e/project",
    "https://github.com/owner/..",
    "https://github.com:8080/owner/project",
  ])("rejects unsupported or ambiguous URL: %s", (input) => {
    expect(() => parseRepositoryUrl(input)).toThrow();
  });
});

function entry(path: string, size = 10): TreeEntry {
  return { path, size, type: "blob", mode: "100644", sha: "a".repeat(40) };
}

describe("bounded source selection", () => {
  it("accepts GitHub's common extensionless README files", () => {
    expect(classifyEntry(entry("README"))).toEqual({});
    expect(selectManifest([entry("README")])[0].status).toBe("available");
  });
  it.each([
    ".env",
    ".env.example",
    "src/.env.local",
    ".aws/config",
    ".npmrc",
    "credentials.json",
    "client-secret.json",
    "private.key",
    "id_ed25519",
  ])("excludes a sensitive file %s", (path) => {
    expect(classifyEntry(entry(path)).reason).toBe("sensitive");
  });
  it.each([
    "node_modules/next/index.js",
    ".next/app/page.js",
    "dist/main.js",
    "package-lock.json",
    "lib/generated/client.ts",
    "public/app.min.js",
  ])("excludes generated file %s", (path) => {
    expect(classifyEntry(entry(path)).reason).toBe("generated");
  });
  it("rejects symlinks, path traversal, unsupported types and oversized files", () => {
    expect(classifyEntry({ ...entry("link.ts"), mode: "120000" }).reason).toBe("unsupported");
    expect(classifyEntry(entry("../escape.ts")).reason).toBe("unsupported");
    expect(classifyEntry(entry("script.py")).reason).toBe("unsupported");
    expect(classifyEntry(entry("image.png")).reason).toBe("binary");
    expect(classifyEntry(entry("big.ts", 65537)).reason).toBe("oversized");
  });
  it("prioritizes manifests and keeps a reason for every file outside the file budget", () => {
    const files = selectManifest([
      ...Array.from({ length: 205 }, (_, i) => entry(`lib/file-${i}.ts`)),
      entry("package.json"),
    ]);
    expect(files[0].path).toBe("package.json");
    expect(files.filter((file) => file.status === "available")).toHaveLength(200);
    expect(files.filter((file) => file.reason === "budget")).toHaveLength(6);
  });
  it("bounds total selected bytes independently of the per-file count", () => {
    const files = selectManifest(
      Array.from({ length: 40 }, (_, i) => entry(`file-${i}.ts`, 64 * 1024)),
    );
    expect(files.filter((file) => file.status === "available")).toHaveLength(32);
    expect(files.filter((file) => file.reason === "budget")).toHaveLength(8);
  });
  it("detects likely embedded credentials without treating ordinary examples as secrets", () => {
    expect(containsLikelySecret('const key = "' + "ghp_" + "x".repeat(36) + '"')).toBe(true);
    expect(containsLikelySecret("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(containsLikelySecret("const key = process.env.GEMINI_API_KEY;")).toBe(false);
  });
});

describe("GitHub response and content validation", () => {
  it("verifies bytes against the Git object and preserves source text", async () => {
    const content = "const answer = 42;\r\nexport { answer };\r\n";
    const blob = blobFor(content);
    const fetcher = vi.fn(async () => Response.json(blob));
    const result = await new GitHubClient({ fetch: fetcher as typeof fetch }).source(
      "owner",
      "repo",
      blob.sha,
    );
    expect(result.content).toBe(content);
    expect(result.contentHash).toBe(createHash("sha256").update(content).digest("hex"));
    expect(result.lineCount).toBe(2);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("rejects content whose hash does not match the requested source", async () => {
    const blob = { ...blobFor("original"), content: Buffer.from("modified").toString("base64") };
    const client = new GitHubClient({ fetch: (async () => Response.json(blob)) as typeof fetch });
    await expect(client.source("owner", "repo", blob.sha)).rejects.toMatchObject({
      code: "SOURCE_MISMATCH",
    });
  });
  it("accepts a valid file at the size limit without adding a phantom trailing line", async () => {
    const content = "x".repeat(65535) + "\n";
    const blob = blobFor(content);
    const client = new GitHubClient({ fetch: (async () => Response.json(blob)) as typeof fetch });
    expect(await client.source("owner", "repo", blob.sha)).toMatchObject({
      content,
      size: 65536,
      lineCount: 1,
    });
  });
  it.each([
    [Buffer.from([0xff, 0xfe]), "BINARY_SOURCE"],
    [Buffer.from("a\0b"), "BINARY_SOURCE"],
    [Buffer.from("-----BEGIN PRIVATE KEY-----"), "SENSITIVE_SOURCE"],
  ])("excludes unsupported or sensitive contents", async (bytes, code) => {
    const blob = blobFor(bytes as Buffer);
    const client = new GitHubClient({ fetch: (async () => Response.json(blob)) as typeof fetch });
    await expect(client.source("owner", "repo", blob.sha)).rejects.toMatchObject({ code });
  });
  it("enforces a streamed download limit even without content-length", async () => {
    const client = new GitHubClient({
      fetch: (async () => new Response("x".repeat(130 * 1024))) as typeof fetch,
    });
    await expect(client.source("owner", "repo", "a".repeat(40))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });
  it("reports quota errors with a retry time and does not leak upstream messages", async () => {
    const client = new GitHubClient({
      fetch: (async () =>
        Response.json(
          { message: "private-upstream-detail" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" },
          },
        )) as typeof fetch,
    });
    await expect(client.repository("owner", "repo")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryAt: new Date(1900000000000).toISOString(),
    });
  });
  it("reports unavailable network access as a user-facing error", async () => {
    const client = new GitHubClient({
      fetch: (async () => {
        throw new Error("internal proxy information");
      }) as typeof fetch,
    });
    await expect(client.repository("owner", "repo")).rejects.toMatchObject({
      code: "GITHUB_UNREACHABLE",
    });
  });
  it("builds an encoded immutable source link", () => {
    expect(sourceUrl({ owner: "owner", name: "repo", commit: COMMIT }, "app/a b.ts", 2)).toBe(
      `https://github.com/owner/repo/blob/${COMMIT}/app/a%20b.ts#L2`,
    );
  });
});
