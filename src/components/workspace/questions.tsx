"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { EvidenceExcerpt, OverviewClaim } from "@/lib/contracts/overview";
import type {
  QuestionDraft,
  QuestionPreview,
  QuestionReadResult,
  QuestionReport,
  QuestionSummary,
} from "@/lib/contracts/questions";
import type { ApiError, RepositorySnapshot } from "@/lib/contracts/repository";
import { workspaceError } from "@/lib/browser/errors";

export type QuestionSession = { draft?: QuestionDraft; report?: QuestionReport; stale?: boolean };
export function RepositoryQuestions({
  snapshot,
  selectedFileId,
  selectedLine,
  session,
  onSession,
  onOpenFile,
  onSnapshotUpdated,
}: {
  snapshot: RepositorySnapshot;
  selectedFileId: string | null;
  selectedLine: number | null;
  session: QuestionSession;
  onSession: (session: QuestionSession) => void;
  onOpenFile: (fileId: string, line: number) => void;
  onSnapshotUpdated: (snapshot: RepositorySnapshot) => void;
}) {
  const eligible = snapshot.files.filter(
    (file) =>
      file.status !== "skipped" && !/(?:^|\/)(?:AGENTS|GEMINI|CLAUDE)\.md$/i.test(file.path),
  );
  const [question, setQuestion] = useState(
    session.draft?.question ?? "Explain how this code works.",
  );
  const [fileId, setFileId] = useState(
    session.draft?.fileId ??
      eligible.find((file) => file.id === selectedFileId)?.id ??
      eligible[0]?.id ??
      "",
  );
  const [line, setLine] = useState(
    String(session.draft ? (session.draft.line ?? "") : (selectedLine ?? "")),
  );
  const [depth, setDepth] = useState<QuestionDraft["depth"]>(session.draft?.depth ?? "learn");
  const [preview, setPreview] = useState<QuestionPreview | null>(null);
  const [report, setReport] = useState<QuestionReport | null>(session.report ?? null);
  const [stale, setStale] = useState(session.stale ?? false);
  const [history, setHistory] = useState<QuestionSummary[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "read" | "answer" | "saved" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const endpoint = `/api/snapshots/${snapshot.id}/questions`;
  const draft: QuestionDraft = {
    question: question.trim(),
    fileId,
    depth,
    ...(line ? { line: Number(line) } : {}),
  };
  const formValid = Boolean(
    draft.question &&
    draft.question.length <= 1000 &&
    fileId &&
    (!line || (/^\d+$/.test(line) && Number(line) > 0 && Number(line) <= 2000000)),
  );
  const contextCurrent = Boolean(
    preview &&
    preview.draft.question === draft.question &&
    preview.draft.fileId === draft.fileId &&
    preview.draft.line === draft.line &&
    preview.draft.depth === draft.depth,
  );
  const retryAt = error?.retryAt ?? preview?.retryAt;
  const cooling = Boolean(retryAt && Date.parse(retryAt) > now);
  const initialReport = useRef(session.report);

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw data.error;
        if (!controller.signal.aborted) {
          setHistory(data.answers);
          setHistoryFailed(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryFailed(true);
      });
    if (initialReport.current)
      fetch(`${endpoint}?answer=${initialReport.current.id}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw data.error;
          if (!controller.signal.aborted) {
            setReport(data.report);
            setStale(data.stale);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(workspaceError(error));
        });
    return () => {
      controller.abort();
      abortRef.current?.abort();
    };
  }, [endpoint]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  function remember(next: QuestionDraft) {
    onSession({ draft: next, report: report ?? undefined, stale });
    setPreview(null);
    setNotice("");
  }
  async function jsonRequest(
    action: "preview" | "read" | "answer",
    current: QuestionDraft,
    signal: AbortSignal,
  ) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        action,
        draft: current,
        ...(action === "answer"
          ? { allowSourceSharing: true, evidenceFingerprint: preview?.evidenceFingerprint }
          : {}),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw data.error;
    return data;
  }
  async function perform(action: "preview" | "read" | "answer") {
    if (!formValid || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(action);
    setError(null);
    setNotice("");
    const current = draft;
    try {
      let data: QuestionPreview;
      if (action === "read") {
        const read = (await jsonRequest("read", current, controller.signal)) as QuestionReadResult;
        if (controller.signal.aborted) return;
        onSnapshotUpdated(read.snapshot);
        setNotice(
          `${read.attempted} new file requests completed. ${read.failures.length ? read.failures.map((failure) => `${failure.path}: ${failure.message}`).join(" ") : "Source already downloaded was reused."}`,
        );
        data = await jsonRequest("preview", current, controller.signal);
      } else data = await jsonRequest(action, current, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(data);
      if (data.report) {
        setReport(data.report);
        setStale(false);
        onSession({ draft: current, report: data.report, stale: false });
        setNotice(
          data.cacheHit || action !== "answer"
            ? "Saved answer reused locally; no Gemini request was made."
            : "Answer checked and saved.",
        );
        setHistory((items) =>
          [
            {
              id: data.report!.id,
              createdAt: data.report!.createdAt,
              draft: data.report!.draft,
              path: data.report!.path,
              model: data.report!.model,
            },
            ...items.filter((item) => item.id !== data.report!.id),
          ].slice(0, 20),
        );
      } else onSession({ draft: current, report: report ?? undefined, stale });
    } catch (error) {
      if (!controller.signal.aborted) setError(workspaceError(error));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function openSaved(id: string) {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("saved");
    setError(null);
    try {
      const response = await fetch(`${endpoint}?answer=${id}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw data.error;
      if (controller.signal.aborted) return;
      const saved = data.report as QuestionReport;
      setQuestion(saved.draft.question);
      setFileId(saved.draft.fileId);
      setLine(String(saved.draft.line ?? ""));
      setDepth(saved.draft.depth);
      setPreview(null);
      setReport(saved);
      setStale(data.stale);
      setNotice("Opened a saved answer. No Gemini request was made.");
      onSession({ draft: saved.draft, report: saved, stale: data.stale });
    } catch (error) {
      if (!controller.signal.aborted) setError(workspaceError(error));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  function stop() {
    abortRef.current?.abort();
    setBusy(null);
    setPreview(null);
    setError({
      code: "CANCELLED",
      message:
        "Stopped waiting. Downloads already completed stay available. A request already sent to Gemini may still count toward provider usage.",
    });
  }
  function citation(item: EvidenceExcerpt) {
    return (
      <button
        key={item.id}
        type="button"
        className="ai-source-link"
        onClick={() => onOpenFile(item.fileId, item.startLine)}
        title={`Read ${item.path}, lines ${item.startLine}–${item.endLine}`}
      >
        {item.path}
        <span>
          L{item.startLine}–{item.endLine}
        </span>
        <ArrowUpRight size={12} />
      </button>
    );
  }
  function claim(item: OverviewClaim) {
    return (
      <div className="ai-claim">
        <span className={`ai-claim-status ${item.status}`}>{item.status}</span>
        <p>{item.text}</p>
        {item.limitation && <p className="ai-assumption">{item.limitation}</p>}
        <div className="ai-citations">
          {item.evidenceIds
            .map((id) => report?.evidence.find((item) => item.id === id))
            .filter((item): item is EvidenceExcerpt => Boolean(item))
            .map(citation)}
        </div>
      </div>
    );
  }

  return (
    <section className="repository-questions" aria-labelledby="questions-heading">
      <div className="map-heading">
        <div>
          <span className="eyebrow">ONE QUESTION, GROUNDED IN CODE</span>
          <h2 id="questions-heading">Make the next connection.</h2>
          <p>Ask about a file, inspect the context, and follow the answer back to its source.</p>
        </div>
        <span className="deterministic-badge">
          <MessageCircle size={13} />
          Scoped questions
        </span>
      </div>
      <div className="question-layout">
        <div className="question-main">
          <form
            className="ai-setup-card question-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void perform("preview");
            }}
          >
            <fieldset disabled={Boolean(busy)}>
              <legend className="sr-only">Question scope and explanation depth</legend>
              <label htmlFor="question-file">Source file</label>
              <select
                id="question-file"
                value={fileId}
                onChange={(event) => {
                  const next = event.target.value;
                  setFileId(next);
                  setLine("");
                  remember({ ...draft, fileId: next, line: undefined });
                }}
              >
                {eligible.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.path}
                    {file.status === "fetched" ? "" : " · unread"}
                  </option>
                ))}
              </select>
              <div className="question-options">
                <div>
                  <label htmlFor="question-line">
                    Focus line <span>optional</span>
                  </label>
                  <input
                    id="question-line"
                    type="number"
                    min="1"
                    max="2000000"
                    value={line}
                    onChange={(event) => {
                      setLine(event.target.value);
                      remember({
                        ...draft,
                        line: event.target.value ? Number(event.target.value) : undefined,
                      });
                    }}
                    placeholder="Auto"
                  />
                </div>
                <div>
                  <label htmlFor="question-depth">Explanation depth</label>
                  <select
                    id="question-depth"
                    value={depth}
                    onChange={(event) => {
                      const next = event.target.value as QuestionDraft["depth"];
                      setDepth(next);
                      remember({ ...draft, depth: next });
                    }}
                  >
                    <option value="quick">Quick · direct answer</option>
                    <option value="learn">Learn · intuition and mechanics</option>
                    <option value="deep">Deep · flow, failures, tradeoffs</option>
                  </select>
                </div>
              </div>
              <label htmlFor="repository-question">Your question</label>
              <textarea
                id="repository-question"
                rows={4}
                maxLength={1000}
                value={question}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  remember({ ...draft, question: event.target.value.trim() });
                }}
                placeholder="What happens when this function runs?"
              />
              <div className="question-input-foot">
                <span>{question.length}/1000</span>
                <span>Keep credentials and private data out of your question.</span>
              </div>
              <div className="question-suggestions">
                {[
                  "What does this file do?",
                  "Explain the selected function step by step.",
                  "What can fail here, and how is it handled?",
                ].map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => {
                      setQuestion(text);
                      remember({ ...draft, question: text });
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </fieldset>
            <p className="map-caption">
              Each question stands on its own. Saved answers stay on this computer and are not
              automatically sent as conversation history.
            </p>
            <div className="ai-generate-row">
              <button
                type="submit"
                className="secondary-button"
                disabled={!formValid || Boolean(busy)}
              >
                <ShieldCheck size={14} />
                Preview cached context
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!formValid || Boolean(busy)}
                onClick={() => void perform("read")}
              >
                <RefreshCw size={14} />
                Read context & preview · up to 4 files
              </button>
            </div>
            <p className="map-caption">
              Previewing uses cached source only. Reading context can download the selected file,
              configuration, and direct imports from GitHub. Neither action calls Gemini.
            </p>
          </form>
          {error && (
            <div className="ai-error" role="alert">
              {error.message}
              {error.retryAt && <p>Retry after {new Date(error.retryAt).toLocaleTimeString()}.</p>}
            </div>
          )}
          {notice && (
            <p className="ai-status" role="status">
              {notice}
            </p>
          )}
          {busy && (
            <div className="question-progress" role="status">
              <LoaderCircle size={16} className="spin" />
              <span>
                {busy === "answer"
                  ? "Asking Gemini and checking references; this can take up to two minutes."
                  : busy === "read"
                    ? "Reading a bounded source batch and rebuilding context…"
                    : "Preparing local context…"}
              </span>
              <button className="secondary-button" type="button" onClick={stop}>
                <X size={13} />
                Stop waiting
              </button>
            </div>
          )}
          {contextCurrent && preview && (
            <div className="ai-setup-card question-context">
              <h3>Context for this question</h3>
              <p className="map-caption">
                {preview.path}
                {preview.draft.line ? ` · line ${preview.draft.line}` : ""} ·{" "}
                {preview.evidence.length} excerpts · {(preview.payloadBytes / 1024).toFixed(1)} KiB
                evidence payload
              </p>
              {preview.prerequisite && <p>{preview.prerequisite}</p>}
              {!preview.configuration.ready && (
                <div className="ai-config">
                  <h4>Gemini configuration needed</h4>
                  <p>
                    Set{" "}
                    {preview.configuration.missing.map((name) => (
                      <code key={name}>{name} </code>
                    ))}{" "}
                    in <code>.env.local</code>, then restart Abstract. Saved answers and local
                    previews work without a key.
                  </p>
                </div>
              )}
              {preview.evidence.length > 0 && (
                <details className="ai-preview">
                  <summary>Review question evidence</summary>
                  {preview.evidence.map((item) => (
                    <details key={item.id}>
                      <summary>
                        {item.path}
                        <span>
                          L{item.startLine}–{item.endLine}
                          {item.wholeFile ? " · whole file" : " · excerpt"}
                        </span>
                      </summary>
                      <pre>
                        {item.text
                          .split("\n")
                          .map((line, index) => `${item.startLine + index}  ${line}`)
                          .join("\n")}
                      </pre>
                    </details>
                  ))}
                </details>
              )}
              <p className="ai-sharing">
                <ShieldCheck size={14} />
                <span>
                  Answering sends your question, selected excerpts, source metadata, and coverage
                  limits to Google Gemini. Provider usage and data terms apply.
                </span>
              </p>
              <button
                className="primary-button"
                type="button"
                disabled={
                  !preview.canGenerate || Boolean(busy) || cooling || Boolean(preview.report)
                }
                onClick={() => void perform("answer")}
              >
                <Sparkles size={14} />
                {preview.report
                  ? "Saved answer is available"
                  : "Send question & excerpts to Gemini"}
              </button>
              {cooling && (
                <p className="map-caption">
                  New Gemini requests available after {new Date(retryAt!).toLocaleTimeString()}.
                </p>
              )}
              <details className="question-context-limits">
                <summary>Context limits</summary>
                <ul>
                  {preview.limitations.map((limit, index) => (
                    <li key={index}>{limit}</li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          {report && (
            <article
              className="ai-report question-answer"
              aria-labelledby="question-answer-heading"
            >
              {stale && (
                <div className="map-stale" role="status">
                  This saved answer uses older source, policy or model settings. Preview current
                  context before requesting an updated answer.
                </div>
              )}
              <div className="ai-section">
                <span className="eyebrow">SAVED ANSWER · {report.draft.depth.toUpperCase()}</span>
                <h3 id="question-answer-heading">{report.draft.question}</h3>
                <p className="question-answer-scope">
                  {report.path}
                  {report.draft.line ? ` · line ${report.draft.line}` : ""} · commit{" "}
                  {report.commit.slice(0, 7)}
                </p>
                <p className="ai-disclosure">
                  AI interpretation with checked reference identifiers. Claims still need review
                  against the source; this is a static explanation, not runtime verification.
                </p>
                {claim(report.content.answer)}
                {report.content.steps.length > 0 && (
                  <ol className="question-steps">
                    {report.content.steps.map((step, index) => (
                      <li key={index}>
                        <h4>{step.title}</h4>
                        {claim(step.explanation)}
                      </li>
                    ))}
                  </ol>
                )}
                <h4>The reusable idea</h4>
                {claim(report.content.takeaway)}
              </div>
              {report.content.concepts.length > 0 && (
                <div className="ai-section">
                  <h3>
                    Concepts <span>General programming knowledge</span>
                  </h3>
                  {report.content.concepts.map((concept, index) => (
                    <div key={index}>
                      <h4>{concept.name}</h4>
                      <p>{concept.explanation}</p>
                    </div>
                  ))}
                </div>
              )}
              <details className="ai-section ai-limits">
                <summary>Limitations and evidence coverage</summary>
                <ul>
                  {[...new Set([...report.content.limitations, ...report.limitations])].map(
                    (limit, index) => (
                      <li key={index}>{limit}</li>
                    ),
                  )}
                </ul>
              </details>
              <footer className="ai-report-footer">
                <span>
                  {report.modelVersion ?? report.model} · {report.promptVersion} ·{" "}
                  {new Date(report.createdAt).toLocaleString()}
                </span>
                <span>
                  {report.usage.inputTokens ?? "Unreported"} input ·{" "}
                  {report.usage.outputTokens ?? "unreported"} output tokens ·{" "}
                  {(report.durationMs / 1000).toFixed(1)}s
                </span>
              </footer>
            </article>
          )}
          {!report && !busy && (
            <div className="map-empty">
              <BookOpen size={28} />
              <h3>Start with one useful question.</h3>
              <p>
                Choose the code you want to understand, preview its context, then ask Gemini.
                Citations open the original source without discarding your question.
              </p>
            </div>
          )}
        </div>
        <aside className="question-history" aria-label="Saved questions">
          <h3>
            Saved questions <span>{history.length}</span>
          </h3>
          <p>Up to 20 answers per snapshot. Opening one makes no AI request.</p>
          {historyFailed && (
            <p role="status">Saved questions could not be loaded. Reopen this tab to retry.</p>
          )}
          {!history.length && !historyFailed && <p>No answers saved yet.</p>}
          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={report?.id === item.id}
              onClick={() => void openSaved(item.id)}
            >
              <strong>{item.draft.question}</strong>
              <span>{item.path}</span>
              <small>
                {item.draft.depth} · {new Date(item.createdAt).toLocaleDateString()}
              </small>
            </button>
          ))}
        </aside>
      </div>
    </section>
  );
}
