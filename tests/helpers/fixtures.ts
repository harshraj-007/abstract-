import { createHash } from "node:crypto";
import {
  DEFAULT_LIMITS,
  INGESTION_VERSION,
  type RepositorySnapshot,
} from "../../src/lib/contracts/repository";
import { selectManifest, type TreeEntry } from "../../src/lib/github/filter";

export const COMMIT = "a".repeat(40);
export const TREE = "b".repeat(40);
export const SNAPSHOT_ID = "c6acbf4b-c1a8-47aa-9389-03028bc70926";

export const FIXTURE_SOURCES: Record<string, string> = {
  "README.md": "# Booking fixture\n\nA deliberately small test repository.\n",
  "package.json": '{\n  "name": "booking-fixture",\n  "dependencies": { "next": "16.3.6" }\n}\n',
  "src/app/page.tsx": "export default function Page() {\n  return <h1>Book a venue</h1>;\n}\n",
  "src/app/api/bookings/route.ts":
    "export async function POST() {\n  return Response.json({ accepted: true });\n}\n",
};

export function blobFor(content: string | Buffer) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") };
}

export function fixtureTree(): TreeEntry[] {
  return [
    ...Object.entries(FIXTURE_SOURCES).map(([path, content]) => ({
      path,
      mode: "100644",
      type: "blob" as const,
      sha: blobFor(content).sha,
      size: Buffer.byteLength(content),
    })),
    { path: ".env.local", mode: "100644", type: "blob", sha: "e".repeat(40), size: 20 },
    {
      path: "node_modules/dependency/index.js",
      mode: "100644",
      type: "blob",
      sha: "d".repeat(40),
      size: 30,
    },
    { path: "public/logo.png", mode: "100644", type: "blob", sha: "f".repeat(40), size: 500 },
  ];
}

export function fixtureSnapshot(): RepositorySnapshot {
  return {
    id: SNAPSHOT_ID,
    owner: "fixture-owner",
    name: "booking-fixture",
    description: "An explicit test fixture, not a live repository.",
    defaultBranch: "main",
    commit: COMMIT,
    language: "TypeScript",
    createdAt: "2026-11-23T09:00:00Z",
    ingestionVersion: INGESTION_VERSION,
    discoveryComplete: true,
    limitations: [
      "Source is downloaded when opened. No architecture or AI analysis has been performed.",
    ],
    files: selectManifest(fixtureTree()),
    limits: { ...DEFAULT_LIMITS },
  };
}

export function mockGitHubFetch(
  options: { truncated?: boolean; tree?: TreeEntry[]; private?: boolean } = {},
) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected host");
    const route = url.pathname;
    if (route.endsWith("/repos/fixture-owner/booking-fixture"))
      return Response.json({
        name: "booking-fixture",
        owner: { login: "fixture-owner" },
        private: options.private ?? false,
        description: "Test fixture",
        default_branch: "main",
        language: "TypeScript",
      });
    if (route.endsWith("/commits/main"))
      return Response.json({ sha: COMMIT, commit: { tree: { sha: TREE } } });
    if (route.endsWith(`/git/trees/${TREE}`))
      return Response.json({
        truncated: options.truncated ?? false,
        tree: options.tree ?? fixtureTree(),
      });
    const sha = route.split("/").at(-1);
    const content = Object.values(FIXTURE_SOURCES).find((content) => blobFor(content).sha === sha);
    if (route.includes("/git/blobs/") && content !== undefined)
      return Response.json(blobFor(content));
    throw new Error(`Unexpected fixture request: ${route}`);
  };
}
