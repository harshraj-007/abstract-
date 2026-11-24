import type { EntryPoint, ParsedFile, StructuralAnalysis } from "@/lib/contracts/analysis";
import type { RepositorySnapshot, SourceFile } from "@/lib/contracts/repository";
import type { Configuration } from "./configuration";
import { stableId } from "./parser";

export function discoverNextEntries(
  snapshot: RepositorySnapshot,
  files: ParsedFile[],
  sources: SourceFile[],
  config: Configuration,
) {
  const limitations: string[] = [];
  let framework: StructuralAnalysis["framework"] = {
    name: config.packageRead ? "generic" : "unknown",
    label: config.packageRead ? "Generic JavaScript / TypeScript" : "Framework not confirmed",
  };
  if (!config.hasNext) return { framework, entryPoints: [] as EntryPoint[], limitations };
  const appRoot = snapshot.files.some((file) => file.path.startsWith("app/"))
    ? "app"
    : snapshot.files.some((file) => file.path.startsWith("src/app/"))
      ? "src/app"
      : undefined;
  if (!appRoot) {
    limitations.push(
      "Next.js is declared, but no App Router root was discovered. Pages Router and workspace applications are not mapped yet.",
    );
    framework = { name: "generic", label: "Next.js (no App Router root mapped)" };
    return { framework, entryPoints: [] as EntryPoint[], limitations };
  }
  framework = { name: "next-app", label: "Next.js App Router conventions", appRoot };
  const configSources = sources.filter((source) => /^next\.config\.[cm]?[jt]s$/.test(source.path));
  if (configSources.some((source) => /\bpageExtensions\b/.test(source.content))) {
    limitations.push(
      "next.config mentions pageExtensions. Custom extensions are not evaluated; route discovery is disabled to avoid misleading endpoints.",
    );
    return { framework, entryPoints: [] as EntryPoint[], limitations };
  }
  if (
    snapshot.files.some((file) => /^next\.config\.[cm]?[jt]s$/.test(file.path)) &&
    configSources.length === 0
  )
    limitations.push(
      "Next.js configuration is unread. Entry points use default filename conventions and may be affected by custom pageExtensions.",
    );
  if (snapshot.files.some((file) => /^(src\/)?pages\//.test(file.path)))
    limitations.push(
      "Pages Router files are visible in the import map but are not interpreted as routes by this adapter.",
    );
  const entryPoints: EntryPoint[] = [];
  for (const file of files) {
    if (file.status !== "parsed" || !file.path.startsWith(`${appRoot}/`)) continue;
    const relative = file.path.slice(appRoot.length + 1);
    const match = /^(?:(.*)\/)?(page|layout|route)\.(tsx|jsx|ts|js)$/.exec(relative);
    if (!match) continue;
    const segments = match[1]?.split("/") ?? [];
    if (segments.some((segment) => segment.startsWith("_"))) continue;
    if (segments.some((segment) => segment.startsWith("@") || /^\(\.{1,3}\)/.test(segment))) {
      limitations.push(
        `${file.path}: parallel/intercepting routes need additional routing context and are not interpreted.`,
      );
      continue;
    }
    const kind = match[2] as EntryPoint["kind"];
    if (kind !== "route" && !file.exportLocations.default) {
      limitations.push(
        `${file.path}: filename matches ${kind}, but a default value export was not found.`,
      );
      continue;
    }
    const methods =
      kind === "route"
        ? ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].filter(
            (name) => file.exportLocations[name],
          )
        : [];
    if (kind === "route" && !methods.length) {
      limitations.push(`${file.path}: no supported HTTP method export was found.`);
      continue;
    }
    const routePath = "/" + segments.filter((segment) => !/^\([^/]+\)$/.test(segment)).join("/");
    entryPoints.push({
      id: stableId(file.fileId, "entry"),
      fileId: file.fileId,
      path: file.path,
      kind,
      routePath,
      methods,
      source: file.exportLocations[kind === "route" ? methods[0] : "default"],
    });
  }
  const routeGroups = new Map<string, EntryPoint[]>();
  for (const entry of entryPoints.filter((entry) => entry.kind !== "layout"))
    routeGroups.set(entry.routePath, [...(routeGroups.get(entry.routePath) ?? []), entry]);
  for (const [route, entries] of routeGroups)
    if (entries.length > 1)
      limitations.push(
        `${route} has multiple page/route candidates. Routing conflicts have not been validated by a Next.js build.`,
      );
  return {
    framework,
    entryPoints: entryPoints.sort(
      (a, b) => a.routePath.localeCompare(b.routePath) || a.kind.localeCompare(b.kind),
    ),
    limitations,
  };
}
