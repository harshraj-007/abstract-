import { describe, expect, it } from "vitest";
import { analyzeSnapshot, analysisFingerprint } from "@/lib/analysis/analyze";
import { analysisFixture, LEARNING_REPO } from "./helpers/analysis-fixtures";

function analyze(contents: Record<string, string>, cached?: string[]) {
  const fixture = analysisFixture(contents, cached);
  return { ...fixture, report: analyzeSnapshot(fixture.snapshot, fixture.sources) };
}

describe("source-grounded structural analysis", () => {
  it("resolves relative paths, tsconfig aliases and JavaScript extension substitution", () => {
    const { report, snapshot } = analyze(LEARNING_REPO);
    const paths = new Map(snapshot.files.map((file) => [file.id, file.path]));
    const links = report.edges.map((edge) => [paths.get(edge.from), paths.get(edge.to)]);
    expect(links).toContainEqual(["src/app/page.tsx", "src/components/widget.tsx"]);
    expect(links).toContainEqual(["src/components/widget.tsx", "src/lib/users.ts"]);
    expect(report.coverage.unresolvedReferences).toBe(0);
    expect(report.coverage.unreadFiles).toBe(0);
    expect(report.status).toBe("ready");
  });

  it("retains import-line evidence and distinguishes type-only references", () => {
    const { report, sources } = analyze(LEARNING_REPO);
    const page = report.files.find((file) => file.path === "src/app/page.tsx")!;
    const reference = page.imports.find((reference) => reference.specifier === "@/types/user")!;
    expect(reference.typeOnly).toBe(true);
    expect(reference.source.startLine).toBe(2);
    expect(reference.source.endLine).toBe(2);
    expect(reference.source.contentHash).toBe(
      sources.find((source) => source.path === page.path)!.contentHash,
    );
  });

  it("recognizes declared package boundaries and Node built-ins without inventing their internals", () => {
    const { report } = analyze(LEARNING_REPO);
    const references = report.files.flatMap((file) => file.imports);
    expect(references.find((reference) => reference.specifier === "react")).toMatchObject({
      resolution: "external",
      packageName: "react",
    });
    expect(references.find((reference) => reference.specifier === "node:crypto")).toMatchObject({
      resolution: "external",
    });
    expect(report.edges.some((edge) => edge.to === "react")).toBe(false);
  });

  it("extracts functions, interfaces, class methods, directives and exact definition ranges", () => {
    const { report } = analyze(LEARNING_REPO);
    const library = report.files.find((file) => file.path === "src/lib/users.ts")!;
    expect(library.symbols.find((symbol) => symbol.name === "findUser")).toMatchObject({
      kind: "function",
      exported: true,
      source: { startLine: 2, endLine: 2 },
    });
    expect(library.symbols.find((symbol) => symbol.name === "UserStore.read")).toMatchObject({
      kind: "method",
      async: true,
      exported: false,
    });
    expect(report.files.find((file) => file.path.endsWith("/widget.tsx"))?.clientDirective).toBe(
      true,
    );
    expect(report.files.find((file) => file.path.endsWith("/page.tsx"))?.clientDirective).toBe(
      false,
    );
  });

  it("records re-exports separately from imports", () => {
    const { report } = analyze(LEARNING_REPO);
    const index = report.files.find((file) => file.path === "src/lib/index.ts")!;
    expect(index.imports).toHaveLength(2);
    expect(index.imports[0]).toMatchObject({ form: "re-export", resolution: "internal" });
    expect(index.imports[1]).toMatchObject({ form: "re-export", typeOnly: true });
  });

  it("recognizes inline type re-exports and declaration-only targets", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts": 'export { type User } from "./types";',
      "types.d.ts": "export interface User { name: string }",
    });
    expect(report.files.find((file) => file.path === "main.ts")?.imports[0]).toMatchObject({
      typeOnly: true,
      resolution: "internal",
    });
    expect(report.files.find((file) => file.path === "main.ts")?.imports[0].reason).toContain(
      "runtime implementation",
    );
  });

  it("does not mistake a checked-in node_modules file for project source", () => {
    const { report } = analyze({
      "package.json": '{"dependencies":{"react":"19"}}',
      "main.ts": 'import React from "react";',
      "node_modules/react/index.d.ts": "export default {};",
    });
    expect(report.edges).toHaveLength(0);
    expect(report.files.find((file) => file.path === "main.ts")?.imports[0].resolution).toBe(
      "external",
    );
  });

  it("returns valid source references for all definitions and edges", () => {
    const { report, sources } = analyze(LEARNING_REPO);
    const locations = [
      ...report.edges.map((edge) => edge.source),
      ...report.files.flatMap((file) => file.symbols.map((symbol) => symbol.source)),
      ...report.entryPoints.map((entry) => entry.source),
    ];
    for (const location of locations) {
      const source = sources.find((source) => source.fileId === location.fileId)!;
      expect(location.contentHash).toBe(source.contentHash);
      expect(location.startLine).toBeGreaterThanOrEqual(1);
      expect(location.endLine).toBeGreaterThanOrEqual(location.startLine);
      expect(location.endLine).toBeLessThanOrEqual(source.lineCount);
    }
  });

  it("can resolve a manifest target while honestly leaving its source unread", () => {
    const { report } = analyze(LEARNING_REPO, [
      "package.json",
      "tsconfig.json",
      "src/app/page.tsx",
    ]);
    expect(report.files).toHaveLength(1);
    expect(report.edges).toHaveLength(2);
    expect(report.coverage.unreadFiles).toBeGreaterThan(0);
    expect(report.status).toBe("partial");
    expect(report.files.some((file) => file.path === "src/components/widget.tsx")).toBe(false);
  });

  it("keeps missing files and computed dynamic imports unresolved", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts":
        'import { absent } from "./missing";\nconst target = "./plugin";\nexport const load = () => import(target);\n',
    });
    expect(report.coverage.unresolvedReferences).toBe(2);
    expect(report.edges).toHaveLength(0);
    expect(report.files[0].imports.find((reference) => reference.form === "dynamic")).toMatchObject(
      { computed: true, resolution: "unresolved" },
    );
  });

  it("resolves literal dynamic imports without presenting them as calls", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts": 'export const load = () => import("./lazy");',
      "lazy.ts": "export const value = 1;",
    });
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].form).toBe("dynamic");
    expect(report.limitations.join(" ")).toContain("not function-call traces");
  });

  it("does not mistake strings/comments for imports or run imported source", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts":
        '// import x from "./fake";\nconst text = \'import y from "./fake2"\';\nthrow new Error("This source must never execute");\n',
    });
    expect(report.edges).toHaveLength(0);
    expect(report.files[0].imports).toHaveLength(0);
  });

  it("reports CommonJS as unsupported instead of inventing ESM relationships", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.js": 'const x = require("./dependency");',
      "dependency.js": "module.exports = {};",
    });
    expect(report.files.find((file) => file.path === "main.js")?.diagnostics.join(" ")).toContain(
      "CommonJS",
    );
    expect(report.edges).toHaveLength(0);
    expect(report.status).toBe("partial");
  });

  it("excludes malformed files from verified dependency edges", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts": 'import { x } from "./other";\nconst broken = ;',
      "other.ts": "export const x = 1;",
    });
    expect(report.coverage.syntaxErrorFiles).toBe(1);
    expect(report.coverage.parsedFiles).toBe(1);
    expect(report.edges).toHaveLength(0);
    expect(report.files.find((file) => file.path === "main.ts")?.diagnostics[0]).toContain(
      "Line 2",
    );
  });

  it("preserves CRLF source line numbers", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts":
        '\r\nimport { x } from "./other";\r\nexport function read() {\r\n  return x;\r\n}\r\n',
      "other.ts": "export const x = 1;",
    });
    const file = report.files.find((file) => file.path === "main.ts")!;
    expect(file.imports[0].source).toMatchObject({ startLine: 2, endLine: 2 });
    expect(file.symbols.find((symbol) => symbol.name === "read")?.source).toMatchObject({
      startLine: 3,
      endLine: 5,
    });
  });

  it("never resolves absolute disk paths outside the virtual repository", () => {
    const { report } = analyze({
      "package.json": "{}",
      "main.ts": 'import data from "/etc/passwd";',
    });
    expect(report.files[0].imports[0].resolution).toBe("unresolved");
    expect(report.edges).toHaveLength(0);
  });

  it("does not guess aliases when tsconfig is unread", () => {
    const { report } = analyze(LEARNING_REPO, ["package.json", "src/app/page.tsx"]);
    expect(report.coverage.unresolvedReferences).toBe(2);
    expect(report.limitations.join(" ")).toContain("tsconfig.json has not been downloaded");
  });

  it("supports local JSONC configuration inheritance without executing plugins", () => {
    const contents = {
      ...LEARNING_REPO,
      "tsconfig.json":
        '{ "extends": "./config/base.json", "compilerOptions": { "plugins": [{ "name": "never-execute" }] } }',
      "config/base.json":
        '{ "compilerOptions": { "baseUrl": "..", "paths": { "@/*": ["src/*"] } } }',
    };
    const { report } = analyze(contents);
    expect(report.coverage.unresolvedReferences).toBe(0);
    expect(report.status).toBe("ready");
  });

  it("reports package-based inheritance rather than loading packages from the host", () => {
    const { report } = analyze({
      ...LEARNING_REPO,
      "tsconfig.json": '{ "extends": "@untrusted/config", "compilerOptions": {} }',
    });
    expect(report.limitations.join(" ")).toContain("Package-based configuration inheritance");
    expect(report.status).toBe("partial");
  });

  it("uses a stable fingerprint and invalidates it when more source is read", () => {
    const { snapshot, sources, report } = analyze(LEARNING_REPO);
    expect(analysisFingerprint(snapshot, [...sources].reverse())).toBe(report.fingerprint);
    expect(analyzeSnapshot(snapshot, sources).id).toBe(report.id);
    expect(analysisFingerprint(snapshot, sources.slice(1))).not.toBe(report.fingerprint);
  });

  it("exposes partial repository discovery even if all selected files are parsed", () => {
    const { snapshot, sources } = analysisFixture(LEARNING_REPO);
    snapshot.discoveryComplete = false;
    expect(analyzeSnapshot(snapshot, sources).status).toBe("partial");
  });
});

describe("Next.js App Router adapter", () => {
  it("detects pages, layouts, route groups, dynamic patterns and HTTP exports", () => {
    const { report } = analyze(LEARNING_REPO);
    expect(report.framework).toMatchObject({ name: "next-app", appRoot: "src/app" });
    expect(report.entryPoints.find((entry) => entry.path.includes("(admin)"))).toMatchObject({
      kind: "page",
      routePath: "/users/[id]",
    });
    expect(report.entryPoints.find((entry) => entry.kind === "route")).toMatchObject({
      routePath: "/api/users",
      methods: ["GET", "POST"],
      source: { startLine: 2 },
    });
    expect(report.entryPoints.find((entry) => entry.kind === "layout")).toMatchObject({
      routePath: "/",
    });
  });

  it("requires framework evidence and a real default export", () => {
    const generic = analyze({
      "package.json": "{}",
      "app/page.tsx": "export default () => <div />;",
    }).report;
    expect(generic.entryPoints).toHaveLength(0);
    const next = analyze({
      "package.json": '{"dependencies":{"next":"16"}}',
      "app/page.tsx": "export const NotAPage = () => <div />;",
    }).report;
    expect(next.entryPoints).toHaveLength(0);
    expect(next.limitations.join(" ")).toContain("default value export");
  });

  it("supports anonymous default exports and exported method aliases", () => {
    const { report } = analyze({
      "package.json": '{"dependencies":{"next":"16"}}',
      "app/page.tsx": "export default () => <div />;",
      "app/api/route.ts":
        "async function handler() { return Response.json({}); }\nexport { handler as GET };",
    });
    expect(report.entryPoints.find((entry) => entry.kind === "page")).toMatchObject({
      source: { startLine: 1 },
    });
    expect(report.entryPoints.find((entry) => entry.kind === "route")).toMatchObject({
      methods: ["GET"],
      source: { startLine: 2 },
    });
  });

  it("does not treat private folders or type-only method names as routes", () => {
    const { report } = analyze({
      "package.json": '{"dependencies":{"next":"16"}}',
      "app/_private/page.tsx": "export default () => <div />;",
      "app/api/route.ts": "export interface GET { name: string };",
    });
    expect(report.entryPoints).toHaveLength(0);
  });

  it("prefers the root app folder over src/app and reports custom extensions", () => {
    const { report } = analyze({
      "package.json": '{"dependencies":{"next":"16"}}',
      "app/page.tsx": "export default () => <div />;",
      "src/app/page.tsx": "export default () => <div />;",
      "next.config.ts": 'export default { pageExtensions: ["custom.tsx"] };',
    });
    expect(report.framework.appRoot).toBe("app");
    expect(report.entryPoints).toHaveLength(0);
    expect(report.limitations.join(" ")).toContain("pageExtensions");
  });

  it("leaves parallel and intercepting routes unresolved", () => {
    const { report } = analyze({
      "package.json": '{"dependencies":{"next":"16"}}',
      "app/@modal/page.tsx": "export default () => <div />;",
      "app/(.)photos/page.tsx": "export default () => <div />;",
    });
    expect(report.entryPoints).toHaveLength(0);
    expect(report.limitations.join(" ")).toContain("parallel/intercepting");
  });
});
