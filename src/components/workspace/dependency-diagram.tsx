"use client";

import { useId } from "react";
import type { StructuralAnalysis, DependencyEdge } from "@/lib/contracts/analysis";
import type { RepositorySnapshot } from "@/lib/contracts/repository";

export function DependencyDiagram({
  analysis,
  snapshot,
  focusId,
  onOpen,
}: {
  analysis: StructuralAnalysis;
  snapshot: RepositorySnapshot;
  focusId: string;
  onOpen: (fileId: string, line: number) => void;
}) {
  const markerId = useId().replace(/:/g, "");
  const byId = new Map(snapshot.files.map((file) => [file.id, file]));
  const parsedIds = new Set(
    analysis.files.filter((file) => file.status === "parsed").map((file) => file.fileId),
  );
  const focus = byId.get(focusId);
  if (!focus) return null;

  function neighbors(direction: "in" | "out") {
    const groups = new Map<string, DependencyEdge[]>();
    for (const edge of analysis.edges) {
      if (edge.from === edge.to) continue;
      if (direction === "in" ? edge.to !== focusId : edge.from !== focusId) continue;
      const id = direction === "in" ? edge.from : edge.to;
      groups.set(id, [...(groups.get(id) ?? []), edge]);
    }
    return [...groups.entries()].sort(([a], [b]) =>
      (byId.get(a)?.path ?? "").localeCompare(byId.get(b)?.path ?? ""),
    );
  }
  const incoming = neighbors("in");
  const outgoing = neighbors("out");
  const rows = Math.max(1, Math.min(4, Math.max(incoming.length, outgoing.length)));
  const height = Math.max(230, rows * 88 + 60);
  const centerY = height / 2;

  function keyboard(event: React.KeyboardEvent<SVGGElement>, fileId: string, line: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(fileId, line);
    }
  }

  function node(fileId: string, x: number, y: number, line: number, central = false) {
    const file = byId.get(fileId);
    if (!file) return null;
    const name = file.path.split("/").at(-1)!;
    const parent = file.path.includes("/")
      ? file.path.slice(0, -name.length - 1)
      : "repository root";
    const isParsed = parsedIds.has(fileId);
    return (
      <g
        key={fileId}
        role="button"
        tabIndex={0}
        aria-label={`Open ${file.path} at line ${line}`}
        onClick={() => onOpen(fileId, line)}
        onKeyDown={(event) => keyboard(event, fileId, line)}
        className={`diagram-node ${central ? "diagram-node-focus" : ""}`}
      >
        <title>
          {file.path} —{" "}
          {isParsed ? "parsed source" : "target exists in manifest; source not parsed"}
        </title>
        <rect
          x={x}
          y={y - 31}
          width={220}
          height={62}
          rx={6}
          strokeDasharray={isParsed ? undefined : "5 3"}
        />
        <text x={x + 13} y={y - 10} className="diagram-node-folder">
          {parent.length > 28 ? "…" + parent.slice(-27) : parent}
        </text>
        <text x={x + 13} y={y + 9} className="diagram-node-name">
          {name.length > 27 ? name.slice(0, 25) + "…" : name}
        </text>
        <text x={x + 13} y={y + 23} className="diagram-node-status">
          {central
            ? "SELECTED SOURCE · OPEN ↗"
            : isParsed
              ? "SOURCE PARSED ↗"
              : "MANIFEST TARGET · OPEN ↗"}
        </text>
      </g>
    );
  }

  function connector(
    edge: DependencyEdge,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    count: number,
  ) {
    const middle = (x1 + x2) / 2;
    const label =
      count > 1
        ? `${count} references`
        : edge.form === "re-export"
          ? "re-exports"
          : edge.form === "dynamic"
            ? "dynamic import"
            : edge.typeOnly
              ? "type import"
              : "imports";
    return (
      <g
        key={edge.id}
        className="diagram-edge"
        role="button"
        tabIndex={0}
        aria-label={`Open ${edge.form} in ${edge.source.path} at line ${edge.source.startLine}`}
        onClick={() => onOpen(edge.source.fileId, edge.source.startLine)}
        onKeyDown={(event) => keyboard(event, edge.source.fileId, edge.source.startLine)}
      >
        <path
          d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`}
          fill="none"
          markerEnd={`url(#${markerId})`}
          strokeDasharray={edge.form === "dynamic" || edge.typeOnly ? "4 4" : undefined}
        />
        <rect x={middle - 43} y={(y1 + y2) / 2 - 11} width={86} height={18} rx={4} />
        <text x={middle} y={(y1 + y2) / 2 + 1} textAnchor="middle">
          {label}
        </text>
      </g>
    );
  }

  return (
    <div className="dependency-visual">
      <div className="diagram-column-headings">
        <span>IMPORTED BY</span>
        <span>SELECTED FILE</span>
        <span>IMPORTS / RE-EXPORTS</span>
      </div>
      <div className="diagram-scroll" tabIndex={0} aria-label="Scrollable dependency diagram">
        <svg
          viewBox={`0 0 900 ${height}`}
          className="dependency-svg"
          role="group"
          aria-label={`Source dependency map for ${focus.path}`}
        >
          <defs>
            <marker
              id={markerId}
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M 0 0 L 7 3.5 L 0 7 Z" fill="currentColor" />
            </marker>
          </defs>
          {incoming
            .slice(0, 4)
            .map(([, edges], index) =>
              connector(
                edges[0],
                230,
                (height - (Math.min(incoming.length, 4) - 1) * 88) / 2 + index * 88,
                340,
                centerY,
                edges.length,
              ),
            )}
          {outgoing
            .slice(0, 4)
            .map(([, edges], index) =>
              connector(
                edges[0],
                560,
                centerY,
                670,
                (height - (Math.min(outgoing.length, 4) - 1) * 88) / 2 + index * 88,
                edges.length,
              ),
            )}
          {incoming
            .slice(0, 4)
            .map(([id, edges], index) =>
              node(
                id,
                10,
                (height - (Math.min(incoming.length, 4) - 1) * 88) / 2 + index * 88,
                edges[0].source.startLine,
              ),
            )}
          {node(focusId, 340, centerY, 1, true)}
          {outgoing
            .slice(0, 4)
            .map(([id], index) =>
              node(id, 670, (height - (Math.min(outgoing.length, 4) - 1) * 88) / 2 + index * 88, 1),
            )}
          {!incoming.length && (
            <text x="120" y={centerY} textAnchor="middle" className="diagram-empty-text">
              No parsed file imports this file.
            </text>
          )}
          {!outgoing.length && (
            <text x="780" y={centerY} textAnchor="middle" className="diagram-empty-text">
              No resolved project imports.
            </text>
          )}
        </svg>
      </div>
      <div className="diagram-legend">
        <span>
          <i />
          Parsed source
        </span>
        <span>
          <i className="legend-dashed" />
          Unparsed target
        </span>
        <span>Click a node to read code. Click an arrow label to inspect the reference.</span>
      </div>
      {(incoming.length > 4 || outgoing.length > 4) && (
        <p className="map-caption">
          This compact view shows up to four files on each side. All references remain listed below.
        </p>
      )}
    </div>
  );
}
