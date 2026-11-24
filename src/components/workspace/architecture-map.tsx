"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Braces,
  CheckCircle2,
  Code2,
  FileCode2,
  GitBranch,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  ANALYSIS_DOWNLOAD_BATCH,
  type AnalysisEvent,
  type AnalysisResult,
  type ModuleReference,
  type StructuralAnalysis,
} from "@/lib/contracts/analysis";
import type { ApiError, RepositorySnapshot } from "@/lib/contracts/repository";
import { DependencyDiagram } from "./dependency-diagram";

type Inspector = "references" | "entries" | "symbols" | "unknowns";

function isSupported(path: string) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);
}
function toError(error: unknown): ApiError {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return { code: "MAP_ERROR", message: error.message };
  return {
    code: "MAP_ERROR",
    message:
      "The map could not be built. Downloaded source and the previous saved map are still available.",
  };
}

export function ArchitectureMap({
  snapshot,
  selectedFileId,
  onOpenFile,
  onSnapshotUpdated,
}: {
  snapshot: RepositorySnapshot;
  selectedFileId: string | null;
  onOpenFile: (fileId: string, line: number) => void;
  onSnapshotUpdated: (snapshot: RepositorySnapshot) => void;
}) {
  const [analysis, setAnalysis] = useState<StructuralAnalysis | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Extract<AnalysisEvent, { type: "progress" }> | null>(
    null,
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState("");
  const [inspector, setInspector] = useState<Inspector>("references");
  const [symbolQuery, setSymbolQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const id = snapshot.id;
  const cachedCount = snapshot.files.filter(
    (file) => file.status === "fetched" && isSupported(file.path),
  ).length;
  const candidateCount = snapshot.files.filter(
    (file) => file.status !== "skipped" && isSupported(file.path),
  ).length;
  const pending = snapshot.files.filter(
    (file) =>
      (file.status === "available" || file.status === "failed") &&
      (isSupported(file.path) ||
        ["package.json", "tsconfig.json", "jsconfig.json"].includes(file.path)),
  ).length;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/snapshots/${id}/analysis`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw data.error;
        if (!controller.signal.aborted) {
          const result = data as AnalysisResult;
          setAnalysis(result.analysis);
          setStale(result.stale);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(toError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      abortRef.current?.abort();
    };
  }, [id]);

  async function build(fetchMissing: boolean) {
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setProgress({
      type: "progress",
      stage: fetchMissing ? "reading" : "parsing",
      message: fetchMissing
        ? "Preparing a bounded source-reading batch…"
        : "Indexing downloaded source…",
      completed: 0,
      total: Math.min(pending, ANALYSIS_DOWNLOAD_BATCH),
    });
    try {
      const response = await fetch(`/api/snapshots/${id}/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fetchMissing }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw data.error;
      }
      if (!response.body) throw new Error("The map response was interrupted. Please try again.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingText = "";
      let completed = false;
      function accept(line: string) {
        if (!line.trim() || controller.signal.aborted) return;
        const event = JSON.parse(line) as AnalysisEvent;
        if (event.type === "error") throw event.error;
        if (event.type === "progress") setProgress(event);
        if (event.type === "complete") {
          completed = true;
          setAnalysis(event.analysis);
          setStale(event.stale);
          onSnapshotUpdated(event.snapshot);
        }
      }
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pendingText += decoder.decode(value, { stream: true });
          const lines = pendingText.split("\n");
          pendingText = lines.pop() ?? "";
          lines.forEach(accept);
        }
        pendingText += decoder.decode();
        if (pendingText.trim()) accept(pendingText);
        if (!completed && !controller.signal.aborted)
          throw new Error("The map response was interrupted. Downloaded source remains saved.");
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(toError(error));
    } finally {
      if (abortRef.current === controller) setProgress(null);
    }
  }

  const focusId = [
    focus,
    selectedFileId,
    analysis?.entryPoints[0]?.fileId,
    analysis?.files[0]?.fileId,
  ].find((candidate) => candidate && analysis?.files.some((file) => file.fileId === candidate));
  const focused = analysis?.files.find((file) => file.fileId === focusId);
  const visibleFiles =
    analysis?.files.filter(
      (file) =>
        file.path.toLowerCase().includes(filter.toLowerCase()) &&
        (!group ||
          analysis.groups.find((item) => item.name === group)?.fileIds.includes(file.fileId)),
    ) ?? [];
  const symbols =
    analysis?.files
      .flatMap((file) => file.symbols)
      .filter((symbol) =>
        `${symbol.name} ${symbol.source.path}`.toLowerCase().includes(symbolQuery.toLowerCase()),
      ) ?? [];
  const unresolved =
    analysis?.files
      .flatMap((file) => file.imports)
      .filter((reference) => reference.resolution === "unresolved") ?? [];
  const diagnostics = analysis?.files.filter((file) => file.diagnostics.length) ?? [];

  return (
    <section className="architecture-map" aria-labelledby="map-heading">
      <div className="map-heading">
        <div>
          <span className="eyebrow">A MAP MADE FROM THE SOURCE</span>
          <h2 id="map-heading">Read the connections.</h2>
          <p>
            Imports, declarations, and entry points. Every relationship has a place in the code.
          </p>
        </div>
        <span className="deterministic-badge">
          <ShieldCheck size={14} />
          Static analysis · no AI
        </span>
      </div>
      <div className="map-action-bar">
        <div>
          <strong>
            {analysis
              ? `${analysis.coverage.parsedFiles} source files parsed`
              : `${cachedCount} source files already downloaded`}
          </strong>
          <span>{analysis?.framework.label ?? "Start with source, then expand the map."}</span>
        </div>
        <div className="map-action-buttons">
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(progress) || loading || !cachedCount}
            onClick={() => build(false)}
          >
            <RefreshCw size={13} />
            {analysis ? "Rebuild downloaded source" : "Use downloaded source"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(progress) || loading || !pending}
            onClick={() => build(true)}
          >
            <Layers3 size={14} />
            {analysis ? "Read next 20 files" : "Read up to 20 & build map"}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
      <p className="map-caption">
        Reads at most {ANALYSIS_DOWNLOAD_BATCH} new files per batch, including configuration. GitHub
        quotas apply. Existing downloads are reused.
      </p>
      {error && (
        <div className="error-notice" role="alert">
          <TriangleAlert size={17} />
          <div>
            <strong>Map building needs attention.</strong>
            <p>{error.message}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss map error"
            onClick={() => setError(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {progress && (
        <div className="import-progress" aria-live="polite">
          <div className="progress-title">
            <LoaderCircle className="spin" size={16} />
            <span>{progress.message}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                abortRef.current?.abort();
                setProgress(null);
                setStale(Boolean(analysis));
              }}
            >
              Stop reading
            </button>
          </div>
          {progress.stage === "reading" && (
            <p className="map-caption">
              {progress.completed} of up to {progress.total} source requests completed. Leaving this
              tab stops the task; downloaded files stay saved.
            </p>
          )}
        </div>
      )}
      {loading ? (
        <div className="map-empty">
          <LoaderCircle size={26} className="spin" />
          <h3>Opening the saved map…</h3>
        </div>
      ) : !analysis ? (
        <div className="map-empty">
          <GitBranch size={36} />
          <h3>
            {candidateCount
              ? "Start connecting the pieces."
              : "No supported source files in this snapshot."}
          </h3>
          <p>
            {candidateCount
              ? "Build a map from downloaded source, or read a small batch first. You’ll see which project files depend on each other, where symbols are defined, and which Next.js entry points can be confirmed."
              : "This map supports JavaScript and TypeScript. You can still browse other selected text files in Source explorer; the snapshot coverage lists exclusions."}
          </p>
          <div className="map-empty-facts">
            <span>
              <CheckCircle2 size={14} />
              Real source references
            </span>
            <span>
              <CheckCircle2 size={14} />
              No repository execution
            </span>
            <span>
              <CheckCircle2 size={14} />
              Unknowns stay visible
            </span>
          </div>
        </div>
      ) : (
        <>
          {stale && (
            <div className="map-stale" role="status">
              <RefreshCw size={15} />
              <span>
                Downloaded source has changed since this map was built. Rebuild it to include the
                new evidence.
              </span>
            </div>
          )}
          <div className="map-stats">
            <div>
              <span>PARSED SOURCE</span>
              <strong>
                {analysis.coverage.parsedFiles}
                <small> / {analysis.coverage.candidateFiles}</small>
              </strong>
            </div>
            <div>
              <span>PROJECT REFERENCES</span>
              <strong>{analysis.coverage.internalReferences}</strong>
            </div>
            <div>
              <span>DECLARED SYMBOLS</span>
              <strong>{analysis.coverage.symbolCount}</strong>
            </div>
            <div>
              <span>ENTRY POINTS</span>
              <strong>{analysis.entryPoints.length}</strong>
            </div>
          </div>
          <div className="map-scope-note">
            <span
              className={`file-badge ${analysis.status === "ready" ? "badge-fetched" : "badge-skipped"}`}
            >
              {analysis.status === "partial" ? "Partial map" : "Selected source indexed"}
            </span>
            <span>
              {analysis.coverage.unreadFiles} unread source files ·{" "}
              {analysis.coverage.unresolvedReferences} unresolved references ·{" "}
              {analysis.coverage.externalReferences} external references
            </span>
            <span>Commit {analysis.commit.slice(0, 7)}</span>
          </div>
          <div className="map-workspace">
            <aside className="map-file-index">
              <div className="map-index-title">
                <FileCode2 size={14} />
                <span>PARSED FILES</span>
                <span>{analysis.files.length}</span>
              </div>
              <div className="map-search">
                <Search size={14} />
                <label className="sr-only" htmlFor="map-file-filter">
                  Find a mapped file
                </label>
                <input
                  id="map-file-filter"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Find a mapped file…"
                />
              </div>
              <label className="sr-only" htmlFor="map-folder-filter">
                Filter mapped folder
              </label>
              <select
                id="map-folder-filter"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
              >
                <option value="">All folder groups</option>
                {analysis.groups.map((item) => (
                  <option value={item.name} key={item.name}>
                    {item.name} · {item.parsedCount}/{item.fileIds.length}
                  </option>
                ))}
              </select>
              <div className="map-file-list">
                {visibleFiles.map((file) => (
                  <button
                    type="button"
                    onClick={() => setFocus(file.fileId)}
                    key={file.fileId}
                    aria-pressed={focusId === file.fileId}
                    title={file.path}
                    className={focusId === file.fileId ? "map-file-active" : ""}
                  >
                    <Code2 size={13} />
                    <span>
                      {file.path}
                      <small>
                        {file.status === "syntax-error"
                          ? "Syntax error"
                          : `${file.symbols.length} symbols · ${file.imports.length} references`}
                      </small>
                    </span>
                    {file.clientDirective && <span className="client-label">client</span>}
                  </button>
                ))}
                {!visibleFiles.length && (
                  <p className="map-caption">No parsed files match this view.</p>
                )}
              </div>
            </aside>
            <div className="map-detail">
              {focused && focusId ? (
                <>
                  <div className="map-focus-heading">
                    <div>
                      <span>DEPENDENCY FOCUS</span>
                      <h3>{focused.path}</h3>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onOpenFile(focusId, 1)}
                    >
                      Read source
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                  <DependencyDiagram
                    analysis={analysis}
                    snapshot={snapshot}
                    focusId={focusId}
                    onOpen={onOpenFile}
                  />
                  <p className="map-reading-tip">
                    <GitBranch size={14} />
                    Read left to right: a file on the left imports the selected file; the selected
                    file imports a file on the right. Unparsed files can have unknown additional
                    relationships.
                  </p>
                </>
              ) : (
                <div className="map-empty">
                  <Braces size={26} />
                  <h3>No source has been parsed yet.</h3>
                  <p>
                    Read another batch or open a supported source file. Review the limitations below
                    if downloads failed.
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="map-inspector">
            <div className="map-inspector-tabs" role="tablist" aria-label="Map details">
              {(
                [
                  { id: "references", title: "References", count: focused?.imports.length ?? 0 },
                  { id: "entries", title: "Entry points", count: analysis.entryPoints.length },
                  { id: "symbols", title: "Symbols", count: analysis.coverage.symbolCount },
                  { id: "unknowns", title: "Unknowns & limits", count: unresolved.length },
                ] as const
              ).map((tab) => (
                <button
                  type="button"
                  role="tab"
                  key={tab.id}
                  id={`map-tab-${tab.id}`}
                  aria-controls={`map-panel-${tab.id}`}
                  aria-selected={inspector === tab.id}
                  tabIndex={inspector === tab.id ? 0 : -1}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                      event.preventDefault();
                      const tabs: Inspector[] = ["references", "entries", "symbols", "unknowns"];
                      const next =
                        tabs[
                          (tabs.indexOf(inspector) +
                            (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                            tabs.length
                        ];
                      setInspector(next);
                      document.getElementById(`map-tab-${next}`)?.focus();
                    }
                  }}
                  onClick={() => setInspector(tab.id)}
                >
                  {tab.title}
                  <span>{tab.count}</span>
                </button>
              ))}
            </div>
            {inspector === "references" && (
              <div role="tabpanel" id="map-panel-references" aria-labelledby="map-tab-references">
                <p className="map-inspector-intro">
                  Module references written in {focused?.path ?? "the selected file"}. A resolved
                  import is not proof that a function is called.
                </p>
                <ReferenceList references={focused?.imports ?? []} onOpen={onOpenFile} />
                <div className="incoming-references">
                  <h4>Files importing this source</h4>
                  {analysis.edges
                    .filter((edge) => edge.to === focusId)
                    .map((edge) => (
                      <button
                        type="button"
                        key={edge.id}
                        onClick={() => onOpenFile(edge.source.fileId, edge.source.startLine)}
                      >
                        <GitBranch size={13} />
                        <span>{edge.source.path}</span>
                        <small>L{edge.source.startLine}</small>
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  {!analysis.edges.some((edge) => edge.to === focusId) && (
                    <p className="map-caption">
                      No incoming references were found in parsed files. Unread files may still
                      import it.
                    </p>
                  )}
                </div>
              </div>
            )}
            {inspector === "entries" && (
              <div role="tabpanel" id="map-panel-entries" aria-labelledby="map-tab-entries">
                <p className="map-inspector-intro">
                  App Router conventions confirmed in parsed source and the root dependency
                  manifest. HTTP labels are exported names, not tested endpoints. Route handlers do
                  not participate in page layouts.
                </p>
                <div className="map-table-scroll">
                  <table className="map-table">
                    <thead>
                      <tr>
                        <th>ROUTE PATTERN</th>
                        <th>KIND / EXPORTS</th>
                        <th>SOURCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.entryPoints.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            <code>{entry.routePath}</code>
                          </td>
                          <td>
                            {entry.kind}
                            {entry.methods.length ? ` · ${entry.methods.join(", ")}` : ""}
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() => onOpenFile(entry.fileId, entry.source.startLine)}
                            >
                              {entry.path}
                              <span>
                                L{entry.source.startLine}
                                <ArrowUpRight size={12} />
                              </span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!analysis.entryPoints.length && (
                    <p className="map-table-empty">
                      No supported entry points have been confirmed yet. Read package.json and
                      relevant app files, then rebuild.
                    </p>
                  )}
                </div>
              </div>
            )}
            {inspector === "symbols" && (
              <div role="tabpanel" id="map-panel-symbols" aria-labelledby="map-tab-symbols">
                <div className="map-symbol-heading">
                  <p>
                    Top-level declarations and class methods. These are definitions, not a call
                    graph.
                  </p>
                  <div className="map-search">
                    <Search size={14} />
                    <label className="sr-only" htmlFor="symbol-search">
                      Find a symbol
                    </label>
                    <input
                      id="symbol-search"
                      placeholder="Find a symbol…"
                      value={symbolQuery}
                      onChange={(event) => setSymbolQuery(event.target.value)}
                    />
                  </div>
                </div>
                <div className="map-table-scroll">
                  <table className="map-table">
                    <thead>
                      <tr>
                        <th>SYMBOL</th>
                        <th>KIND</th>
                        <th>DEFINITION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {symbols.slice(0, 100).map((symbol) => (
                        <tr key={symbol.id}>
                          <td>
                            <code>{symbol.name}</code>
                            {symbol.exported && (
                              <span className="symbol-export">
                                {symbol.defaultExport ? "default export" : "exported"}
                              </span>
                            )}
                          </td>
                          <td>
                            {symbol.async ? "async " : ""}
                            {symbol.kind}
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() =>
                                onOpenFile(symbol.source.fileId, symbol.source.startLine)
                              }
                            >
                              {symbol.source.path}
                              <span>
                                L{symbol.source.startLine}–{symbol.source.endLine}
                                <ArrowUpRight size={12} />
                              </span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!symbols.length && (
                    <p className="map-table-empty">No declarations match this view.</p>
                  )}
                </div>
                {symbols.length > 100 && (
                  <p className="map-caption">
                    Showing the first 100 matching declarations. Narrow the search to find another
                    symbol.
                  </p>
                )}
              </div>
            )}
            {inspector === "unknowns" && (
              <div role="tabpanel" id="map-panel-unknowns" aria-labelledby="map-tab-unknowns">
                <p className="map-inspector-intro">
                  These boundaries are kept visible. Nothing outside the read source has been
                  guessed.
                </p>
                <ReferenceList references={unresolved} onOpen={onOpenFile} />
                {diagnostics.map((file) => (
                  <div className="map-file-diagnostic" key={file.fileId}>
                    <button type="button" onClick={() => onOpenFile(file.fileId, 1)}>
                      {file.path}
                      <ArrowUpRight size={12} />
                    </button>
                    {file.diagnostics.map((message) => (
                      <p key={message}>{message}</p>
                    ))}
                  </div>
                ))}
                {analysis.downloadFailures.map((failure) => (
                  <div className="map-file-diagnostic" key={failure.fileId}>
                    <strong>
                      {snapshot.files.find((file) => file.id === failure.fileId)?.path}
                    </strong>
                    <p>{failure.message}</p>
                  </div>
                ))}
                <ul className="map-limitations">
                  {analysis.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="map-caption map-version">
            {analysis.analyzerVersion} · Built {new Date(analysis.createdAt).toLocaleString()} ·
            Source fingerprint {analysis.fingerprint.slice(0, 12)}
          </p>
        </>
      )}
    </section>
  );
}

function ReferenceList({
  references,
  onOpen,
}: {
  references: ModuleReference[];
  onOpen: (fileId: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const visible = references.filter((reference) =>
    `${reference.specifier} ${reference.source.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="reference-list">
      {references.length > 20 && (
        <div className="reference-filter">
          <label className="sr-only" htmlFor={searchId}>
            Filter module references
          </label>
          <Search size={13} />
          <input
            id={searchId}
            placeholder="Filter by target or source path…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {visible.slice(0, 100).map((reference) => (
        <div className="reference-row" key={reference.id}>
          <div>
            <code>{reference.specifier}</code>
            <span className={`reference-status reference-${reference.resolution}`}>
              {reference.resolution === "internal"
                ? "Project file"
                : reference.resolution === "external"
                  ? "External"
                  : "Unresolved"}
            </span>
            <small>
              {reference.form}
              {reference.typeOnly ? " · type only" : ""}
            </small>
            {reference.reason && <p>{reference.reason}</p>}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => onOpen(reference.source.fileId, reference.source.startLine)}
          >
            {reference.source.path}
            <span>L{reference.source.startLine}</span>
            <ArrowUpRight size={12} />
          </button>
        </div>
      ))}
      {!visible.length && <p className="map-table-empty">No module references match this view.</p>}
      {visible.length > 100 && (
        <p className="map-caption">
          Showing the first 100 matching references. Filter by target or source path to narrow this
          view.
        </p>
      )}
    </div>
  );
}
