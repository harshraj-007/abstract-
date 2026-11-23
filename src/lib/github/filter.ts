import { createHash } from "node:crypto";
import { DEFAULT_LIMITS, type SourceEntry, type SkipReason } from "@/lib/contracts/repository";

export type TreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

const GENERATED = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "generated",
  "playwright-report",
  "test-results",
]);
const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "json",
  "jsonc",
  "md",
  "mdx",
  "txt",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "yaml",
  "yml",
  "toml",
  "xml",
  "sql",
  "prisma",
  "graphql",
  "gql",
  "sh",
  "bash",
  "zsh",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "ini",
  "cfg",
  "conf",
]);
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "svg",
  "pdf",
  "zip",
  "gz",
  "tar",
  "7z",
  "mp4",
  "mov",
  "mp3",
  "wav",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
  "sqlite",
  "db",
  "pyc",
  "class",
]);
const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "cargo.lock",
  "poetry.lock",
]);

export function isSafeRelativePath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 1000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((part) => part !== ".." && part !== "." && part.length > 0)
  );
}

export function classifyEntry(entry: TreeEntry): { reason?: SkipReason; detail?: string } {
  const parts = entry.path.toLowerCase().split("/");
  const basename = parts.at(-1)!;
  const extension = basename.split(".").at(-1)!;
  if (!isSafeRelativePath(entry.path))
    return { reason: "unsupported", detail: "Unsupported source path." };
  if (
    parts.some(
      (part) =>
        part.startsWith(".env") ||
        part === ".aws" ||
        part === ".ssh" ||
        part === ".npmrc" ||
        part === ".netrc",
    ) ||
    /(?:^|[._-])(credentials?|secrets?)(?:[._-]|$)/.test(basename) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(basename) ||
    /^(id_rsa|id_ed25519|\.git-credentials|\.pypirc)$/.test(basename)
  ) {
    return { reason: "sensitive", detail: "Environment, credential, or key file excluded." };
  }
  if (entry.mode === "120000" || entry.type === "commit")
    return { reason: "unsupported", detail: "Symbolic links and submodules are not followed." };
  if (
    parts.some((part) => GENERATED.has(part)) ||
    LOCKFILES.has(basename) ||
    /(?:\.min\.(js|css)|\.map|\.tsbuildinfo)$/.test(basename)
  )
    return { reason: "generated", detail: "Dependency, generated output, or lockfile excluded." };
  if (BINARY_EXTENSIONS.has(extension))
    return { reason: "binary", detail: "Media, binary, or active vector content excluded." };
  if (
    !TEXT_EXTENSIONS.has(extension) &&
    ![
      "readme",
      "license",
      "licence",
      "changelog",
      "notice",
      "dockerfile",
      "makefile",
      "procfile",
    ].includes(basename)
  )
    return {
      reason: "unsupported",
      detail: "This file type is not supported by the explorer yet.",
    };
  if (entry.size === undefined)
    return {
      reason: "unsupported",
      detail: "GitHub did not supply a file size; excluded from the bounded manifest.",
    };
  if (entry.size > DEFAULT_LIMITS.maxFileBytes)
    return { reason: "oversized", detail: "Larger than the 64 KiB source-file limit." };
  return {};
}

export function priorityOf(path: string): number {
  if (/^(package\.json|readme(?:\.[^/]+)?|tsconfig\.json|next\.config\.[^/]+)$/i.test(path))
    return 0;
  if (/(^|\/)(app|pages)\//.test(path) && /\/(page|layout|route)\.[jt]sx?$/.test(path)) return 1;
  if (/\.(ts|tsx|js|jsx|prisma|sql)$/.test(path)) return 2;
  return 3;
}

export function selectManifest(entries: TreeEntry[]): SourceEntry[] {
  let selected = 0;
  let bytes = 0;
  return entries
    .filter((entry) => entry.type !== "tree")
    .sort((a, b) => priorityOf(a.path) - priorityOf(b.path) || a.path.localeCompare(b.path))
    .map((entry) => {
      const exclusion = classifyEntry(entry);
      if (
        !exclusion.reason &&
        (selected >= DEFAULT_LIMITS.maxFiles || bytes + entry.size! > DEFAULT_LIMITS.maxTotalBytes)
      ) {
        exclusion.reason = "budget";
        exclusion.detail = "Outside this snapshot's 200-file / 2 MiB selection budget.";
      }
      if (!exclusion.reason) {
        selected++;
        bytes += entry.size!;
      }
      return {
        id: createHash("sha256").update(entry.path).digest("hex").slice(0, 24),
        path: entry.path,
        sha: entry.sha,
        size: entry.size ?? 0,
        status: exclusion.reason ? "skipped" : "available",
        ...exclusion,
      };
    });
}

export function containsLikelySecret(content: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{35}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(
    content,
  );
}
