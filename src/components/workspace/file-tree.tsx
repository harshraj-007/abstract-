"use client";

import {
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Check,
  Minus,
  AlertCircle,
} from "lucide-react";
import type { SourceEntry } from "@/lib/contracts/repository";

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; file?: SourceEntry };

export function FileTree({
  files,
  selectedId,
  query,
  onSelect,
}: {
  files: SourceEntry[];
  selectedId: string | null;
  query: string;
  onSelect: (file: SourceEntry) => void;
}) {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  const visible = files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase()));
  const selectedPath = files.find((file) => file.id === selectedId)?.path;
  for (const file of visible) {
    let current = root;
    const parts = file.path.split("/");
    parts.forEach((part, index) => {
      if (!current.children.has(part))
        current.children.set(part, {
          name: part,
          path: parts.slice(0, index + 1).join("/"),
          children: new Map(),
        });
      current = current.children.get(part)!;
      if (index === parts.length - 1) current.file = file;
    });
  }

  function renderNodes(node: TreeNode, depth: number): React.ReactNode {
    return [...node.children.values()]
      .sort(
        (a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name),
      )
      .map((child) => {
        if (!child.file) {
          return (
            <details
              className="tree-folder"
              key={child.path}
              open={query || selectedPath?.startsWith(`${child.path}/`) ? true : undefined}
            >
              <summary style={{ paddingLeft: `${14 + depth * 15}px` }}>
                <ChevronRight size={12} className="tree-chevron" />
                <Folder size={15} className="folder-closed" />
                <FolderOpen size={15} className="folder-open" />
                <span>{child.name}</span>
              </summary>
              {renderNodes(child, depth + 1)}
            </details>
          );
        }
        const file = child.file;
        const Icon = /\.[jt]sx?$/.test(file.path) ? FileCode2 : FileText;
        return (
          <button
            type="button"
            key={file.id}
            onClick={() => onSelect(file)}
            className={`tree-file ${file.id === selectedId ? "is-selected" : ""} ${file.status === "skipped" ? "is-excluded" : ""}`}
            style={{ paddingLeft: `${28 + depth * 15}px` }}
            title={file.detail ? `${file.path} — ${file.detail}` : file.path}
            aria-label={file.path}
            aria-describedby={`file-description-${file.id}`}
            aria-pressed={file.id === selectedId}
          >
            <Icon size={14} />
            <span>{child.name}</span>
            <span id={`file-description-${file.id}`} className="sr-only">
              {file.detail ??
                (file.status === "available" ? "Selected; downloads when opened" : file.status)}
            </span>
            {file.status === "fetched" && (
              <Check size={11} className="file-status fetched" aria-label="Downloaded" />
            )}
            {file.status === "skipped" && (
              <Minus size={11} className="file-status" aria-label="Skipped" />
            )}
            {file.status === "failed" && (
              <AlertCircle size={11} className="file-status failed" aria-label="Download failed" />
            )}
          </button>
        );
      });
  }

  return (
    <nav className="file-tree" aria-label="Repository files">
      {visible.length ? (
        renderNodes(root, 0)
      ) : (
        <p className="tree-empty">No files match “{query}”.</p>
      )}
    </nav>
  );
}
