"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Code2,
  Files,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Github,
  Globe2,
  LayoutGrid,
  Leaf,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  Network,
  MessageCircle,
  Menu,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  coverageOf,
  sourceUrl,
  type ApiError,
  type ImportEvent,
  type ProgressStage,
  type RepositorySnapshot,
  type SnapshotSummary,
  type SourceEntry,
  type SourceFile,
} from "@/lib/contracts/repository";
import { FileTree } from "./file-tree";
import { formatBytes, SourceViewer } from "./source-viewer";
import { ArchitectureMap } from "./architecture-map";
import { AiOverview } from "./ai-overview";
import { RepositoryQuestions, type QuestionSession } from "./questions";
import { workspaceError as asError } from "@/lib/browser/errors";

const STEPS: { stage: ProgressStage; label: string }[] = [
  { stage: "resolving", label: "Resolve commit" },
  { stage: "fetching", label: "Read file tree" },
  { stage: "indexing", label: "Select source" },
  { stage: "saving", label: "Save snapshot" },
];
type View = "files" | "map" | "guide" | "questions" | "overview" | "coverage";

function Logo() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function summaryOf(snapshot: RepositorySnapshot): SnapshotSummary {
  const { id, owner, name, commit, createdAt, language } = snapshot;
  return { id, owner, name, commit, createdAt, language };
}

function updateLocation(snapshot: RepositorySnapshot | null, file?: SourceEntry, line?: number) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (snapshot) url.searchParams.set("snapshot", snapshot.id);
  if (file) url.searchParams.set("file", file.id);
  if (line) url.hash = `L${line}`;
  window.history.replaceState(null, "", url);
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  const data = await response.json();
  if (!response.ok)
    throw data.error ?? { code: "REQUEST_FAILED", message: "Could not complete this request." };
  return data as T;
}

export function Explorer() {
  const [url, setUrl] = useState("");
  const [recent, setRecent] = useState<SnapshotSummary[]>([]);
  const [recentError, setRecentError] = useState(false);
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFile | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [progress, setProgress] = useState<Extract<ImportEvent, { type: "progress" }> | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [view, setView] = useState<View>("files");
  const [questionSession, setQuestionSession] = useState<QuestionSession>({});
  const [query, setQuery] = useState("");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const importAbort = useRef<AbortController | null>(null);
  const restoreAbort = useRef<AbortController | null>(null);
  const busy = Boolean(progress) || restoring;
  const selectedFile = snapshot?.files.find((file) => file.id === selectedId);

  function activate(next: RepositorySnapshot, fileId?: string | null, line?: number | null) {
    setQuestionSession({});
    setSnapshot(next);
    const file =
      next.files.find((entry) => entry.id === fileId) ??
      next.files.find(
        (entry) => entry.status !== "skipped" && /^readme(?:\.|$)/i.test(entry.path),
      ) ??
      next.files.find((entry) => entry.status !== "skipped");
    setSelectedId(file?.id ?? null);
    setSource(null);
    setSourceError(null);
    setSourceLoading(Boolean(file && file.status !== "skipped"));
    // Reopening the current snapshot must reload its source even if IDs match.
    setRetry((value) => value + 1);
    setSelectedLine(line ?? null);
    setView("files");
    setQuery("");
    setError(null);
    setMobileMenu(false);
    setRecent((previous) =>
      [summaryOf(next), ...previous.filter((item) => item.id !== next.id)].slice(0, 12),
    );
    updateLocation(next, file, line ?? undefined);
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchJson<{ snapshots: SnapshotSummary[] }>("/api/repositories", controller.signal)
      .then((data) => setRecent(data.snapshots))
      .catch((error) => {
        if (error.name !== "AbortError") setRecentError(true);
      });
    const location = new URL(window.location.href);
    const id = location.searchParams.get("snapshot");
    if (id) {
      Promise.resolve().then(() => setRestoring(true));
      fetchJson<{ snapshot: RepositorySnapshot }>(
        `/api/snapshots/${encodeURIComponent(id)}`,
        controller.signal,
      )
        .then(({ snapshot }) => {
          const line = /^#L([1-9]\d*)$/.exec(location.hash);
          activate(snapshot, location.searchParams.get("file"), line ? Number(line[1]) : null);
        })
        .catch((error) => {
          if (error.name !== "AbortError") setError(asError(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setRestoring(false);
        });
    }
    return () => {
      controller.abort();
      importAbort.current?.abort();
      restoreAbort.current?.abort();
    };
  }, []);

  const snapshotId = snapshot?.id;
  useEffect(() => {
    if (!snapshotId || !selectedId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSource(null);
      setSourceError(null);
      if (snapshot?.files.find((file) => file.id === selectedId)?.status === "skipped") {
        setSourceLoading(false);
        return;
      }
      setSourceLoading(true);
      fetchJson<{ source: SourceFile; snapshot: RepositorySnapshot }>(
        `/api/snapshots/${snapshotId}/files?file=${selectedId}`,
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setSource(result.source);
          setSnapshot((current) =>
            current?.id === result.snapshot.id ? result.snapshot : current,
          );
          setSelectedLine((line) => (line && line <= result.source.lineCount ? line : null));
        })
        .catch(async (error) => {
          if (controller.signal.aborted) return;
          setSourceError(asError(error));
          try {
            const result = await fetchJson<{ snapshot: RepositorySnapshot }>(
              `/api/snapshots/${snapshotId}`,
              controller.signal,
            );
            if (!controller.signal.aborted)
              setSnapshot((current) =>
                current?.id === result.snapshot.id ? result.snapshot : current,
              );
          } catch {
            /* Keep the current source manifest available if refresh fails. */
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSourceLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // A manifest refresh must not start another source download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId, selectedId, retry]);

  async function openRecent(id: string) {
    importAbort.current?.abort();
    restoreAbort.current?.abort();
    const controller = new AbortController();
    restoreAbort.current = controller;
    setProgress(null);
    setRestoring(true);
    setError(null);
    try {
      const result = await fetchJson<{ snapshot: RepositorySnapshot }>(
        `/api/snapshots/${id}`,
        controller.signal,
      );
      if (!controller.signal.aborted) activate(result.snapshot);
    } catch (error) {
      if (!controller.signal.aborted) setError(asError(error));
    } finally {
      if (!controller.signal.aborted) setRestoring(false);
    }
  }

  async function importRepository(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    importAbort.current = controller;
    setError(null);
    setProgress({ type: "progress", stage: "resolving", message: "Connecting to GitHub…" });
    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw data.error;
      }
      if (!response.body) throw new Error("The repository response was interrupted.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let completed = false;
      function accept(line: string) {
        if (!line.trim()) return;
        const event = JSON.parse(line) as ImportEvent;
        if (event.type === "progress") setProgress(event);
        if (event.type === "error") throw event.error;
        if (event.type === "complete") {
          completed = true;
          activate(event.snapshot);
        }
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          lines.forEach(accept);
        }
        pending += decoder.decode();
        if (pending.trim()) accept(pending);
        if (!completed)
          throw new Error("The repository response was interrupted. Please try again.");
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(asError(error));
    } finally {
      if (importAbort.current === controller) setProgress(null);
    }
  }

  function home() {
    setQuestionSession({});
    importAbort.current?.abort();
    restoreAbort.current?.abort();
    setSnapshot(null);
    setSelectedId(null);
    setSource(null);
    setError(null);
    setProgress(null);
    setRestoring(false);
    setMobileMenu(false);
    setUrl("");
    updateLocation(null);
  }

  function chooseFile(file: SourceEntry, preserveQuery = false, line?: number) {
    if (!snapshot) return;
    setView("files");
    if (!preserveQuery) setQuery("");
    if (file.id === selectedId) {
      if (sourceError) setRetry((value) => value + 1);
      if (line !== undefined) setSelectedLine(line);
      updateLocation(snapshot, file, line ?? selectedLine ?? undefined);
      return;
    }
    setSelectedId(file.id);
    setSelectedLine(line ?? null);
    setSourceError(null);
    setSource(null);
    setSourceLoading(file.status !== "skipped");
    updateLocation(snapshot, file, line);
  }

  async function forgetSnapshot() {
    if (!snapshot || deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/snapshots/${snapshot.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw data.error;
      }
      setRecent((previous) => previous.filter((item) => item.id !== snapshot.id));
      home();
    } catch (error) {
      setError(asError(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={`app-shell ${snapshot ? "has-snapshot" : ""}`}>
      {mobileMenu && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <button type="button" className="brand" onClick={home} aria-label="Abstract home">
          <Logo />
          <span>
            abstract<span className="brand-period">.</span>
          </span>
        </button>
        <span className="workspace-label">YOUR WORKSPACE</span>
        <button
          type="button"
          className={`sidebar-item ${!snapshot ? "active" : ""}`}
          onClick={home}
        >
          <LayoutGrid size={17} />
          <span>Overview</span>
        </button>
        <button type="button" className="sidebar-item" onClick={home}>
          <Plus size={17} />
          <span>Open a repository</span>
          <span className="shortcut">↗</span>
        </button>
        <div className="sidebar-divider" />
        <div className="sidebar-section-heading">
          <span>RECENT REPOSITORIES</span>
          <span>{recent.length.toString().padStart(2, "0")}</span>
        </div>
        <div className="recent-list">
          {recent.length ? (
            recent.map((item) => (
              <button
                type="button"
                className={`recent-item ${item.id === snapshot?.id ? "recent-active" : ""}`}
                key={item.id}
                onClick={() => openRecent(item.id)}
                disabled={busy}
              >
                <FolderGit2 size={16} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.owner} <span>·</span> {item.commit.slice(0, 7)}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p className="recent-empty">
              {recentError
                ? "Saved repositories are unavailable. Try reloading the page."
                : "Your next rabbit hole starts here. Open a repository to keep it close."}
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Leaf size={18} />
            <p>
              A little context.
              <br />A lot more clarity.
            </p>
          </div>
          <div className="local-profile">
            <span className="profile-avatar">
              <Code2 size={17} />
            </span>
            <span>
              <strong>Personal workspace</strong>
              <small>Saved on this computer</small>
            </span>
            <span className="local-dot" title="Local workspace" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              type="button"
              className="icon-button mobile-menu-button"
              aria-label="Open navigation"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-root">Workspace</span>
            <ChevronRight size={13} />
            <span>{snapshot ? snapshot.name : "Overview"}</span>
          </div>
          <div className="topbar-right">
            <span className="public-only">
              <Globe2 size={13} />
              Public repositories
            </span>
            <a
              href="https://github.com/harshraj-007/abstract-"
              target="_blank"
              rel="noreferrer"
              className="icon-button"
              aria-label="Abstract project on GitHub"
            >
              <Github size={18} />
            </a>
          </div>
        </header>
        <main id="main-content" className={snapshot ? "workspace-main" : "home-main"}>
          {!snapshot ? (
            <>
              <div className="home-heading">
                <span className="welcome-eyebrow">
                  <span /> A PLACE TO MAKE SENSE OF CODE
                </span>
                <h1>
                  Every codebase
                  <br />
                  has a <em>story.</em>
                </h1>
                <p>
                  Start with the source. Find the connections.
                  <br className="desktop-break" /> Make an unfamiliar project feel like your own.
                </p>
              </div>
              <section className="import-card" aria-labelledby="import-heading">
                <div className="import-card-heading">
                  <div className="import-icon">
                    <FolderGit2 size={21} />
                  </div>
                  <div>
                    <h2 id="import-heading">Where would you like to begin?</h2>
                    <p>Bring a public GitHub repository into your workspace.</p>
                  </div>
                  <span className="step-pill">01 / EXPLORE</span>
                </div>
                <form onSubmit={importRepository}>
                  <label className="sr-only" htmlFor="repository-url">
                    GitHub repository URL
                  </label>
                  <div className={`repository-input-group ${error ? "input-has-error" : ""}`}>
                    <Github size={20} />
                    <input
                      id="repository-url"
                      type="url"
                      placeholder="https://github.com/owner/repository"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      required
                      maxLength={500}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                    />
                    <button className="primary-button" type="submit" disabled={busy}>
                      {busy ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <>
                          Open repository
                          <ArrowRight size={16} />
                        </>
                      )}
                    </button>
                  </div>
                </form>
                <div className="import-card-foot">
                  <span>
                    <LockKeyhole size={12} />
                    Read-only access. Your code stays untouched.
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setUrl("https://github.com/octocat/Hello-World");
                      document.getElementById("repository-url")?.focus();
                    }}
                  >
                    Try a small repository
                    <ArrowUpRight size={12} />
                  </button>
                </div>
              </section>
              {error && <ErrorNotice error={error} dismiss={() => setError(null)} />}
              {busy && (
                <ImportProgress
                  progress={progress}
                  restoring={restoring}
                  cancel={() => {
                    importAbort.current?.abort();
                    restoreAbort.current?.abort();
                    setProgress(null);
                    setRestoring(false);
                  }}
                />
              )}
              <section className="journey-section" aria-labelledby="journey-heading">
                <div className="section-heading">
                  <span id="journey-heading">FROM UNFAMILIAR TO UNDERSTOOD</span>
                  <span>
                    One layer at a time
                    <ArrowDown size={12} />
                  </span>
                </div>
                <div className="journey-grid">
                  <article className="journey-card">
                    <div className="journey-card-top">
                      <Files size={20} />
                      <span className="available-label">AVAILABLE NOW</span>
                    </div>
                    <h3>Meet the source.</h3>
                    <p>
                      Explore real files, follow stable line references, and find a place to start
                      reading.
                    </p>
                    <div className="card-miniature file-miniature" aria-hidden="true">
                      <span>
                        <FolderGit2 size={12} />
                        your-project
                      </span>
                      <span>
                        <span className="mini-line" />
                        <Braces size={12} />
                        app / page.tsx
                      </span>
                      <span>
                        <span className="mini-line" />
                        <Braces size={12} />
                        lib / utils.ts
                      </span>
                    </div>
                    <span className="journey-number">01</span>
                  </article>
                  <article className="journey-card">
                    <div className="journey-card-top">
                      <Box size={20} />
                      <span className="available-label">AVAILABLE NOW</span>
                    </div>
                    <h3>See the bigger picture.</h3>
                    <p>
                      Follow project imports, find declarations, and inspect source-linked entry
                      points.
                    </p>
                    <div className="card-miniature map-miniature" aria-hidden="true">
                      <span>Source</span>
                      <i />
                      <span>Imports</span>
                      <i />
                      <span>Symbols</span>
                    </div>
                    <span className="journey-number">02</span>
                  </article>
                  <article className="journey-card">
                    <div className="journey-card-top">
                      <BookOpen size={20} />
                      <span className="coming-label">OPTIONAL GEMINI</span>
                    </div>
                    <h3>Make it click.</h3>
                    <p>
                      Ask about selected code, choose your explanation depth, and follow cited
                      source. Connect Gemini for answers and an overview; exercises come later.
                    </p>
                    <div className="card-miniature lesson-miniature" aria-hidden="true">
                      <span>
                        <CheckCircle2 size={13} />
                        Understand the idea
                      </span>
                      <span>
                        <span className="empty-mini-check" />
                        Build it yourself
                      </span>
                    </div>
                    <span className="journey-number">03</span>
                  </article>
                </div>
              </section>
              <section className="under-the-hood">
                <div>
                  <span className="under-icon">
                    <ShieldCheck size={19} />
                  </span>
                  <div>
                    <h3>A grounded place to start.</h3>
                    <p>
                      Each repository is pinned to one commit. Files download as you open them.
                      <br className="desktop-break" /> Skipped files and incomplete coverage stay
                      visible.
                    </p>
                  </div>
                </div>
                <details>
                  <summary>
                    <CircleHelp size={15} />
                    How it works
                    <ChevronRight size={13} />
                  </summary>
                  <p>
                    We read repository metadata and its file tree through GitHub, select up to 200
                    text files within a 2 MiB budget, and download source on demand. Snapshots and
                    opened files are saved locally. Nothing from the repository is executed. AI
                    overviews are optional: review bounded excerpts and choose to send them to
                    Google Gemini. The source explorer and structural map need no AI key.
                  </p>
                </details>
              </section>
              <footer className="home-footer">
                <span>Built for the curious.</span>
                <span>READ. CONNECT. CREATE.</span>
              </footer>
            </>
          ) : (
            <>
              <div className="repo-heading">
                <div>
                  <button type="button" className="back-link" onClick={home}>
                    <ArrowLeft size={13} />
                    All repositories
                  </button>
                  <h1>
                    <span>{snapshot.owner} /</span> {snapshot.name}
                  </h1>
                  <p>{snapshot.description || "A fresh perspective on an unfamiliar codebase."}</p>
                </div>
                <a
                  href={sourceUrl(snapshot)}
                  target="_blank"
                  rel="noreferrer"
                  className="secondary-button"
                >
                  View on GitHub
                  <ArrowUpRight size={14} />
                </a>
              </div>
              <div className="snapshot-bar">
                <span>
                  <GitBranch size={14} />
                  {snapshot.defaultBranch}
                </span>
                <a href={sourceUrl(snapshot)} target="_blank" rel="noreferrer">
                  <GitCommitHorizontal size={15} />
                  {snapshot.commit.slice(0, 7)}
                </a>
                <span>
                  <ShieldCheck size={14} />
                  Pinned snapshot
                </span>
                <span className="snapshot-date">
                  Opened{" "}
                  {new Date(snapshot.createdAt).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                  })}
                </span>
              </div>
              {error && <ErrorNotice error={error} dismiss={() => setError(null)} />}
              {restoring && (
                <ImportProgress
                  progress={null}
                  restoring
                  cancel={() => {
                    restoreAbort.current?.abort();
                    setRestoring(false);
                  }}
                />
              )}
              <div className="workspace-tabs" role="tablist" aria-label="Repository views">
                {(
                  [
                    { id: "files", title: "Source explorer", icon: Code2 },
                    { id: "map", title: "Architecture map", icon: Network },
                    { id: "guide", title: "AI overview", icon: Sparkles },
                    { id: "questions", title: "Ask code", icon: MessageCircle },
                    { id: "overview", title: "Snapshot overview", icon: LayoutGrid },
                    { id: "coverage", title: "Coverage", icon: ListFilter },
                  ] as const
                ).map((tab) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === tab.id}
                    aria-controls={`panel-${tab.id}`}
                    id={`tab-${tab.id}`}
                    tabIndex={view === tab.id ? 0 : -1}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                        event.preventDefault();
                        const tabs: View[] = [
                          "files",
                          "map",
                          "guide",
                          "questions",
                          "overview",
                          "coverage",
                        ];
                        const next =
                          tabs[
                            (tabs.indexOf(view) +
                              (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                              tabs.length
                          ];
                        setView(next);
                        document.getElementById(`tab-${next}`)?.focus();
                      }
                    }}
                    onClick={() => setView(tab.id)}
                    key={tab.id}
                  >
                    <tab.icon size={15} />
                    {tab.title}
                    {tab.id === "coverage" && <span>{coverageOf(snapshot).skipped}</span>}
                  </button>
                ))}
                <span className="ai-notice">
                  <Sparkles size={13} />
                  AI lessons are coming later
                </span>
              </div>
              {view === "files" && (
                <div
                  id="panel-files"
                  role="tabpanel"
                  aria-labelledby="tab-files"
                  className="explorer-panels"
                >
                  <section className="file-panel" aria-label="File explorer">
                    <div className="file-panel-heading">
                      <span>EXPLORER</span>
                      <span>
                        {snapshot.files.length} files{!snapshot.discoveryComplete ? "+" : ""}
                      </span>
                    </div>
                    <div className="file-search">
                      <Search size={14} />
                      <label className="sr-only" htmlFor="file-search">
                        Filter files by path
                      </label>
                      <input
                        id="file-search"
                        placeholder="Find a file…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      <span>/</span>
                    </div>
                    <FileTree
                      files={snapshot.files}
                      query={query}
                      selectedId={selectedId}
                      onSelect={(file) => chooseFile(file, true)}
                    />
                    <div className="file-panel-foot">
                      <span className="status-dot" />
                      {coverageOf(snapshot).fetched} downloaded <span>·</span>{" "}
                      {coverageOf(snapshot).skipped} skipped
                    </div>
                  </section>
                  <SourceViewer
                    snapshot={snapshot}
                    file={selectedFile}
                    source={source}
                    loading={sourceLoading}
                    error={sourceError}
                    selectedLine={selectedLine}
                    onLine={(line) => {
                      setSelectedLine(line);
                      if (selectedFile) updateLocation(snapshot, selectedFile, line);
                    }}
                    onRetry={() => setRetry((value) => value + 1)}
                    onAsk={() => {
                      if (!selectedId) return;
                      setQuestionSession({
                        draft: {
                          question: "Explain how this code works.",
                          fileId: selectedId,
                          depth: "learn",
                          ...(selectedLine ? { line: selectedLine } : {}),
                        },
                      });
                      setView("questions");
                    }}
                  />
                </div>
              )}
              {view === "map" && (
                <div id="panel-map" role="tabpanel" aria-labelledby="tab-map">
                  <ArchitectureMap
                    key={snapshot.id}
                    snapshot={snapshot}
                    selectedFileId={selectedId}
                    onOpenFile={(fileId, line) => {
                      const file = snapshot.files.find((entry) => entry.id === fileId);
                      if (file) chooseFile(file, false, line);
                    }}
                    onSnapshotUpdated={(next) =>
                      setSnapshot((current) => (current?.id === next.id ? next : current))
                    }
                  />
                </div>
              )}
              {view === "overview" && (
                <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
                  <Overview
                    snapshot={snapshot}
                    onChoose={chooseFile}
                    onForget={forgetSnapshot}
                    deleting={deleting}
                    onMap={() => setView("map")}
                  />
                </div>
              )}
              {view === "guide" && (
                <div id="panel-guide" role="tabpanel" aria-labelledby="tab-guide">
                  <AiOverview
                    key={snapshot.id}
                    snapshot={snapshot}
                    onMap={() => setView("map")}
                    onOpenFile={(fileId, line) => {
                      const file = snapshot.files.find((entry) => entry.id === fileId);
                      if (file) chooseFile(file, false, line);
                    }}
                  />
                </div>
              )}
              {view === "coverage" && (
                <div id="panel-coverage" role="tabpanel" aria-labelledby="tab-coverage">
                  <Coverage snapshot={snapshot} onChoose={chooseFile} />
                </div>
              )}
              {view === "questions" && (
                <div id="panel-questions" role="tabpanel" aria-labelledby="tab-questions">
                  <RepositoryQuestions
                    snapshot={snapshot}
                    selectedFileId={selectedId}
                    selectedLine={selectedLine}
                    session={questionSession}
                    onSession={setQuestionSession}
                    onOpenFile={(fileId, line) => {
                      const file = snapshot.files.find((entry) => entry.id === fileId);
                      if (file) chooseFile(file, false, line);
                    }}
                    onSnapshotUpdated={(next) =>
                      setSnapshot((current) => (current?.id === next.id ? next : current))
                    }
                  />
                </div>
              )}
              <div className="workspace-footnote">
                <ShieldCheck size={13} />
                <span>
                  Static relationships describe dependencies, not runtime calls. AI explanations are
                  optional interpretations linked to source excerpts.
                </span>
                <span>
                  {!snapshot.discoveryComplete
                    ? "Partial file discovery"
                    : "File discovery complete"}
                </span>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function ErrorNotice({ error, dismiss }: { error: ApiError; dismiss: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <CircleHelp size={18} />
      <div>
        <strong>
          {error.code === "LOCAL_SERVER_UNREACHABLE"
            ? "Abstract is not reachable."
            : error.code === "RATE_LIMITED"
              ? "A short pause from GitHub."
              : "We couldn’t complete that request."}
        </strong>
        <p>{error.message}</p>
        {error.retryAt && <p>Retry after {new Date(error.retryAt).toLocaleTimeString()}.</p>}
      </div>
      <button type="button" className="icon-button" onClick={dismiss} aria-label="Dismiss error">
        <X size={15} />
      </button>
    </div>
  );
}

function ImportProgress({
  progress,
  restoring,
  cancel,
}: {
  progress: Extract<ImportEvent, { type: "progress" }> | null;
  restoring: boolean;
  cancel: () => void;
}) {
  const current = STEPS.findIndex((step) => step.stage === progress?.stage);
  return (
    <section className="import-progress" aria-live="polite">
      <div className="progress-title">
        <LoaderCircle size={16} className="spin" />
        <span>{restoring ? "Opening your saved snapshot…" : progress?.message}</span>
        <button type="button" className="text-button" onClick={cancel}>
          Cancel
        </button>
      </div>
      {!restoring && (
        <div className="progress-steps">
          {STEPS.map((step, index) => (
            <span key={step.stage} className={index <= current ? "step-started" : ""}>
              {index < current ? (
                <Check size={12} />
              ) : (
                <span className="step-indicator">{index + 1}</span>
              )}
              {step.label}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Stats({ snapshot }: { snapshot: RepositorySnapshot }) {
  const coverage = coverageOf(snapshot);
  return (
    <div className="stats-grid">
      {[
        {
          label: "DISCOVERED",
          value: `${coverage.discovered}${snapshot.discoveryComplete ? "" : "+"}`,
          note: snapshot.discoveryComplete
            ? "files in the source manifest"
            : "known files; discovery is partial",
        },
        {
          label: "SELECTED",
          value: coverage.selected,
          note: `within ${formatBytes(coverage.selectedBytes)} of source`,
        },
        { label: "DOWNLOADED", value: coverage.fetched, note: "opened and saved locally" },
        {
          label: "SKIPPED / FAILED",
          value: `${coverage.skipped} / ${coverage.failed}`,
          note: "excluded files / download errors",
        },
      ].map((stat) => (
        <div className="stat-card" key={stat.label}>
          <span>{stat.label}</span>
          <strong>{stat.value}</strong>
          <p>{stat.note}</p>
        </div>
      ))}
    </div>
  );
}

function Overview({
  snapshot,
  onChoose,
  onForget,
  deleting,
  onMap,
}: {
  snapshot: RepositorySnapshot;
  onChoose: (file: SourceEntry) => void;
  onForget: () => void;
  deleting: boolean;
  onMap: () => void;
}) {
  const starters = snapshot.files.filter((file) => file.status !== "skipped").slice(0, 5);
  return (
    <div className="overview-content">
      <Stats snapshot={snapshot} />
      <div className="overview-grid">
        <section className="detail-card">
          <span className="eyebrow">A PLACE TO START READING</span>
          <h2>Open the front door.</h2>
          <p>
            Manifests and documentation come first, followed by entry points and source files. This
            reading list uses file conventions; it is not an AI assessment.
          </p>
          <div className="reading-list">
            {starters.length ? (
              starters.map((file, index) => (
                <button type="button" onClick={() => onChoose(file)} key={file.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <Code2 size={15} />
                  <strong>{file.path}</strong>
                  <ArrowRight size={15} />
                </button>
              ))
            ) : (
              <p>No readable files were selected. The coverage view explains why.</p>
            )}
          </div>
        </section>
        <section className="detail-card">
          <span className="eyebrow">ABOUT THIS SNAPSHOT</span>
          <h2>A moment in the code.</h2>
          <dl className="snapshot-details">
            <div>
              <dt>Repository language</dt>
              <dd>{snapshot.language || "Not reported"}</dd>
            </div>
            <div>
              <dt>Framework</dt>
              <dd>
                <button type="button" className="text-button" onClick={onMap}>
                  Inspect architecture map
                  <ArrowUpRight size={12} />
                </button>
              </dd>
            </div>
            <div>
              <dt>Branch when opened</dt>
              <dd>{snapshot.defaultBranch}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd title={snapshot.commit}>{snapshot.commit.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>Source processing</dt>
              <dd>Read only, never executed</dd>
            </div>
            <div>
              <dt>AI source sharing</dt>
              <dd>Optional · review the AI overview tab</dd>
            </div>
          </dl>
        </section>
      </div>
      <Limitations snapshot={snapshot} />
      <div className="delete-card">
        <div>
          <h3>Remove this snapshot</h3>
          <p>
            Delete its saved file list and downloaded source from this computer. The GitHub
            repository stays untouched.
          </p>
        </div>
        <button type="button" className="danger-button" onClick={onForget} disabled={deleting}>
          <Trash2 size={14} />
          {deleting ? "Removing…" : "Remove snapshot"}
        </button>
      </div>
    </div>
  );
}

function Limitations({ snapshot }: { snapshot: RepositorySnapshot }) {
  return (
    <section className="limitations">
      <ShieldCheck size={19} />
      <div>
        <h3>What this snapshot covers</h3>
        <ul>
          <li>
            Files download on demand. Structural map coverage is reported separately in the
            Architecture map tab.
          </li>
          {snapshot.limitations
            .filter((limitation) => !limitation.startsWith("Source is downloaded"))
            .map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
        </ul>
      </div>
    </section>
  );
}

function Coverage({
  snapshot,
  onChoose,
}: {
  snapshot: RepositorySnapshot;
  onChoose: (file: SourceEntry) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const visible = snapshot.files.filter(
    (file) =>
      (filter === "all" || file.status === filter) &&
      file.path.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="coverage-content">
      <Stats snapshot={snapshot} />
      <Limitations snapshot={snapshot} />
      <section className="coverage-table-card">
        <div className="coverage-toolbar">
          <div>
            <h2>Every file, accounted for.</h2>
            <p>Selected files download when opened. Excluded files retain their reason.</p>
          </div>
          <div className="coverage-filters">
            <label className="sr-only" htmlFor="coverage-search">
              Search coverage paths
            </label>
            <input
              id="coverage-search"
              placeholder="Filter paths…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="sr-only" htmlFor="coverage-status">
              Filter by file status
            </label>
            <select
              id="coverage-status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="available">Selected</option>
              <option value="fetched">Downloaded</option>
              <option value="skipped">Skipped</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
        <div className="coverage-table-scroll">
          <table>
            <thead>
              <tr>
                <th>FILE</th>
                <th>SIZE</th>
                <th>STATUS</th>
                <th>DETAIL</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((file) => (
                <tr key={file.id}>
                  <td>
                    <button type="button" onClick={() => onChoose(file)}>
                      {file.path}
                    </button>
                  </td>
                  <td>{formatBytes(file.size)}</td>
                  <td>
                    <span className={`file-badge badge-${file.status}`}>
                      {file.status === "available"
                        ? "Selected"
                        : file.status === "fetched"
                          ? "Downloaded"
                          : file.status === "skipped"
                            ? "Skipped"
                            : "Failed"}
                    </span>
                  </td>
                  <td>
                    {file.detail ||
                      (file.status === "fetched"
                        ? "Verified and saved locally."
                        : "Downloads when opened.")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && <p className="coverage-empty">No files match these filters.</p>}
        </div>
      </section>
    </div>
  );
}
