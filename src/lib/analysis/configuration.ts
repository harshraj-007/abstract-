import ts from "typescript";
import path from "node:path";
import type { SourceFile } from "@/lib/contracts/repository";

export type Configuration = {
  options: ts.CompilerOptions;
  dependencies: Set<string>;
  hasNext: boolean;
  packageRead: boolean;
  limitations: string[];
};

export function readJsonSource(source: SourceFile | undefined): {
  value?: Record<string, unknown>;
  error?: string;
} {
  if (!source) return {};
  const result = ts.parseConfigFileTextToJson(source.path, source.content);
  if (result.error)
    return {
      error: `${source.path}: ${ts.flattenDiagnosticMessageText(result.error.messageText, " ")}`,
    };
  if (!result.config || typeof result.config !== "object" || Array.isArray(result.config))
    return { error: `${source.path} must contain a JSON object.` };
  return { value: result.config };
}

export function readConfiguration(sources: SourceFile[], manifestPaths?: string[]): Configuration {
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const limitations: string[] = [];
  const dependencies = new Set<string>();
  const pkg = readJsonSource(byPath.get("package.json"));
  if (pkg.error) limitations.push(pkg.error);
  if (!pkg.value)
    limitations.push(
      "Root package.json is unread or invalid. Framework and undeclared package references cannot be confirmed.",
    );
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const entries = pkg.value?.[key];
    if (entries && typeof entries === "object" && !Array.isArray(entries))
      for (const name of Object.keys(entries)) dependencies.add(name);
  }

  const visited = new Set<string>();
  function loadConfig(filename: string, depth: number): ts.CompilerOptions {
    if (visited.has(filename) || depth > 5) {
      limitations.push(`Configuration inheritance stopped at ${filename}: cycle or depth limit.`);
      return {};
    }
    visited.add(filename);
    const parsed = readJsonSource(byPath.get(filename));
    if (!parsed.value) {
      limitations.push(
        parsed.error ?? `${filename} has not been downloaded. Inherited aliases remain unresolved.`,
      );
      return {};
    }
    let inherited: ts.CompilerOptions = {};
    const extension = parsed.value.extends;
    if (typeof extension === "string") {
      if (extension.startsWith(".")) {
        let target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), extension));
        if (!target.endsWith(".json")) target += ".json";
        if (target.startsWith("../") || target.startsWith("/"))
          limitations.push(
            `Configuration ${filename} extends outside the repository; it was not read.`,
          );
        else inherited = loadConfig(target, depth + 1);
      } else
        limitations.push(
          `Package-based configuration inheritance (${extension}) is not loaded or executed.`,
        );
    } else if (Array.isArray(extension))
      limitations.push(`Multiple configuration inheritance in ${filename} is not supported yet.`);
    if (parsed.value.references)
      limitations.push(
        `Project references in ${filename} are not followed. Monorepo boundaries may be incomplete.`,
      );
    const compilerOptions = parsed.value.compilerOptions;
    const raw =
      compilerOptions && typeof compilerOptions === "object" && !Array.isArray(compilerOptions)
        ? (compilerOptions as Record<string, unknown>)
        : {};
    const converted = ts.convertCompilerOptionsFromJson(
      raw,
      path.posix.join("/repo", path.posix.dirname(filename)),
    );
    for (const error of converted.errors.slice(0, 4))
      limitations.push(`${filename}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
    const options = { ...inherited, ...converted.options };
    // Each paths map is relative to the configuration that declared it when no baseUrl is set.
    if (raw.paths && !raw.baseUrl && !inherited.baseUrl)
      options.baseUrl = path.posix.join("/repo", path.posix.dirname(filename));
    return options;
  }

  const paths = new Set(manifestPaths ?? byPath.keys());
  const configPath = paths.has("tsconfig.json")
    ? "tsconfig.json"
    : paths.has("jsconfig.json")
      ? "jsconfig.json"
      : undefined;
  const options: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...(configPath ? loadConfig(configPath, 0) : {}),
  };
  // The module host is virtual and never reads the user's disk, plugins or packages.
  delete options.plugins;
  return {
    options,
    dependencies,
    hasNext: dependencies.has("next"),
    packageRead: Boolean(pkg.value),
    limitations,
  };
}
