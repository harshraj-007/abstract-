import { createHash } from "node:crypto";
import { sourceLines, type SourceFile } from "../../src/lib/contracts/repository";
import { selectManifest } from "../../src/lib/github/filter";
import { blobFor, fixtureSnapshot } from "./fixtures";

export function analysisFixture(
  contents: Record<string, string>,
  cachedPaths = Object.keys(contents),
) {
  const snapshot = fixtureSnapshot();
  snapshot.files = selectManifest(
    Object.entries(contents).map(([path, content]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: blobFor(content).sha,
      size: Buffer.byteLength(content),
    })),
  );
  const sources: SourceFile[] = snapshot.files
    .filter((file) => file.status !== "skipped" && cachedPaths.includes(file.path))
    .map((file) => {
      const content = contents[file.path];
      file.status = "fetched";
      return {
        snapshotId: snapshot.id,
        fileId: file.id,
        path: file.path,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        lineCount: sourceLines(content).length,
      };
    });
  return { snapshot, sources };
}

export const LEARNING_REPO: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "learning-fixture",
    dependencies: { next: "16.3.6", react: "19.2.8" },
  }),
  "tsconfig.json":
    '{ // Aliases are read as JSONC, never evaluated.\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },\n}',
  "src/app/page.tsx":
    'import { Widget } from "@/components/widget";\nimport type { User } from "@/types/user";\nexport default function Home() { return <Widget />; }\n',
  "src/app/layout.tsx":
    "export default function Root({ children }: { children: unknown }) { return children; }\n",
  "src/app/(admin)/users/[id]/page.tsx":
    "export default function Profile() { return <div>Profile</div>; }\n",
  "src/app/api/users/route.ts":
    'import { findUser } from "@/lib/users";\nexport async function GET() { return Response.json(findUser()); }\nexport const POST = async () => Response.json({});\n',
  "src/components/widget.tsx":
    '"use client";\nimport { useState } from "react";\nimport { findUser } from "../lib/users.js";\nexport const Widget = () => <button>{findUser().name}</button>;\n',
  "src/types/user.ts": "export interface User { name: string }\n",
  "src/lib/users.ts":
    'import { randomUUID } from "node:crypto";\nexport function findUser() { return { name: "Fixture", id: randomUUID() }; }\nexport class UserStore { async read() { return findUser(); } }\n',
  "src/lib/index.ts":
    'export { findUser } from "./users";\nexport type { User } from "../types/user";\n',
};
