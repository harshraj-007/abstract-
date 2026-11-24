import ts from "typescript";
import path from "node:path";
import { builtinModules } from "node:module";
import type { ModuleReference } from "@/lib/contracts/analysis";
import type { RepositorySnapshot, SourceFile } from "@/lib/contracts/repository";
import type { Configuration } from "./configuration";

export function createResolver(
  snapshot: RepositorySnapshot,
  sources: SourceFile[],
  config: Configuration,
) {
  const names = new Map(
    snapshot.files
      .filter(
        (file) =>
          file.reason !== "sensitive" &&
          file.reason !== "binary" &&
          file.reason !== "unsupported" &&
          !file.path.split("/").includes("node_modules"),
      )
      .map((file) => [`/repo/${file.path}`, file]),
  );
  const contents = new Map(sources.map((source) => [`/repo/${source.path}`, source.content]));
  const directories = new Set<string>(["/repo"]);
  for (const filename of names.keys()) {
    let directory = path.posix.dirname(filename);
    while (directory.startsWith("/repo")) {
      directories.add(directory);
      if (directory === "/repo") break;
      directory = path.posix.dirname(directory);
    }
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (filename) => names.has(path.posix.normalize(filename)),
    readFile: (filename) => contents.get(path.posix.normalize(filename)),
    directoryExists: (directory) => directories.has(path.posix.normalize(directory)),
    getCurrentDirectory: () => "/repo",
    realpath: (filename) => path.posix.normalize(filename),
  };
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  function matchesAlias(specifier: string) {
    return Object.keys(config.options.paths ?? {}).some((pattern) => {
      const parts = pattern.split("*");
      return parts.length === 1
        ? specifier === pattern
        : specifier.startsWith(parts[0]) && specifier.endsWith(parts[1] ?? "");
    });
  }

  return (reference: ModuleReference): ModuleReference => {
    if (reference.computed) return reference;
    const specifier = reference.specifier;
    const resolved = ts.resolveModuleName(
      specifier,
      `/repo/${reference.source.path}`,
      config.options,
      host,
    ).resolvedModule;
    let target = resolved ? names.get(path.posix.normalize(resolved.resolvedFileName)) : undefined;
    // TypeScript does not resolve side-effect style/assets; allow an exact manifest match only.
    if (!target && specifier.startsWith("."))
      target = names.get(
        path.posix.resolve("/repo", path.posix.dirname(reference.source.path), specifier),
      );
    if (target)
      return {
        ...reference,
        resolution: "internal",
        targetFileId: target.id,
        reason: /\.d\.[cm]?ts$/.test(target.path)
          ? "Resolved to a TypeScript declaration. Its runtime implementation is not determined by this map."
          : undefined,
      };
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("#") ||
      specifier.startsWith("~/") ||
      specifier.startsWith("@/") ||
      matchesAlias(specifier)
    ) {
      return {
        ...reference,
        resolution: "unresolved",
        reason:
          "No supported target was found in this snapshot's manifest. The file, alias configuration, or generated source may be missing.",
      };
    }
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (config.dependencies.has(name) || specifier.startsWith("node:") || builtins.has(specifier)) {
      return {
        ...reference,
        resolution: "external",
        packageName: name,
        reason: "External package or Node built-in; its internals are outside this map.",
      };
    }
    return {
      ...reference,
      resolution: "unresolved",
      reason:
        "Not resolved as a project file or a declared root dependency. It may require unread configuration or a workspace package.",
    };
  };
}
