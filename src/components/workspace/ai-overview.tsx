"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { EvidenceExcerpt, OverviewClaim, OverviewState } from "@/lib/contracts/overview";
import type { ApiError, RepositorySnapshot } from "@/lib/contracts/repository";
import { workspaceError as failure } from "@/lib/browser/errors";

export function AiOverview({
  snapshot,
  onOpenFile,
  onMap,
}: {
  snapshot: RepositorySnapshot;
  onOpenFile: (fileId: string, line: number) => void;
  onMap: () => void;
}) {
  const [state, setState] = useState<OverviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const endpoint = `/api/snapshots/${snapshot.id}/overview`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw data.error;
        if (!controller.signal.aborted) {
          setState(data);
          setError(null);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(failure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      abortRef.current?.abort();
    };
  }, [endpoint, refresh]);
  const retryAt = error?.retryAt ?? state?.retryAt;
  useEffect(() => {
    if (!retryAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [retryAt]);

  async function generate() {
    if (!state?.evidenceFingerprint) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          allowSourceSharing: true,
          evidenceFingerprint: state.evidenceFingerprint,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw data.error;
      if (!controller.signal.aborted) setState(data);
    } catch (error) {
      if (!controller.signal.aborted) setError(failure(error));
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  }
  function stop() {
    abortRef.current?.abort();
    setGenerating(false);
    setError({
      code: "CANCELLED",
      message:
        "Stopped waiting for Gemini. Any request already sent may still count toward provider usage. Saved results remain available.",
    });
    setRefresh((value) => value + 1);
  }
  const report = state?.report;
  const cooling = Boolean(retryAt && Date.parse(retryAt) > now);
  const current = Boolean(report && !state?.stale);
  const evidence = report?.evidence ?? [];
  function citation(excerpt: EvidenceExcerpt) {
    return (
      <button
        key={excerpt.id}
        className="ai-source-link"
        type="button"
        onClick={() => onOpenFile(excerpt.fileId, excerpt.startLine)}
        title={`Read ${excerpt.path}, lines ${excerpt.startLine}–${excerpt.endLine}`}
      >
        {excerpt.path}
        <span>
          L{excerpt.startLine}–{excerpt.endLine}
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
            .map((id) => evidence.find((source) => source.id === id))
            .filter((item): item is EvidenceExcerpt => Boolean(item))
            .map(citation)}
        </div>
      </div>
    );
  }
  return (
    <section className="ai-overview" aria-labelledby="ai-overview-heading">
      <div className="map-heading">
        <div>
          <span className="eyebrow">FROM SOURCE TO UNDERSTANDING</span>
          <h2 id="ai-overview-heading">Find the thread.</h2>
          <p>A project overview, a reading order, and the concepts that connect them.</p>
        </div>
        <span className="deterministic-badge">
          <Sparkles size={13} />
          Gemini · source-linked
        </span>
      </div>
      {loading && (
        <p className="ai-status" role="status">
          <LoaderCircle size={16} className="spinning" />
          Loading saved overview and evidence preview…
        </p>
      )}
      {error && (
        <div className="ai-error" role="alert">
          <strong>{error.message}</strong>
          {error.retryAt && <p>Retry after {new Date(error.retryAt).toLocaleTimeString()}.</p>}
        </div>
      )}
      {!loading && (
        <>
          {state && (
            <div className="ai-setup-card">
              <div className="ai-setup-top">
                <div>
                  <strong>
                    {current
                      ? "Saved overview available"
                      : "Generate from the source you have read"}
                  </strong>
                  <p>
                    {state.configuration.model
                      ? `Model: ${state.configuration.model}`
                      : "Choose a Gemini model on the server."}{" "}
                    No model request runs when you open this tab.
                  </p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={generating}
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  <RefreshCw size={13} />
                  Refresh status
                </button>
              </div>
              {!state.configuration.ready && (
                <div className="ai-config">
                  <h3>Connect Gemini locally</h3>
                  <p>
                    Set{" "}
                    {state.configuration.missing.map((name) => (
                      <code key={name}>{name} </code>
                    ))}{" "}
                    in <code>.env.local</code>, then restart Abstract. Keep your API key on the
                    server.
                  </p>
                  <p>
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      Get a Gemini API key <ArrowUpRight size={12} />
                    </a>
                    <span>
                      Use a model available to your account; free-tier eligibility and quotas vary.
                    </span>
                  </p>
                </div>
              )}
              {state.prerequisite && (
                <div className="ai-prerequisite">
                  <p>{state.prerequisite}</p>
                  <button type="button" className="secondary-button" onClick={onMap}>
                    Open architecture map
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
              {state.evidence.length > 0 && (
                <>
                  <details className="ai-preview">
                    <summary>
                      Review excerpts to share{" "}
                      <span>
                        {state.evidence.length} files · {(state.payloadBytes / 1024).toFixed(1)} KiB
                        evidence payload
                      </span>
                    </summary>
                    <p>
                      Only the excerpts below, repository identity, structural facts tied to these
                      excerpts, and coverage limits are sent. {state.omittedFiles} other cached
                      files are omitted. Large files may be excerpted.
                    </p>
                    {state.evidence.map((item) => (
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
                  <p className="ai-sharing">
                    <ShieldCheck size={14} />
                    <span>
                      Generating sends these public source excerpts to Google Gemini. Provider usage
                      and data terms apply. Opening files or building a map sends no source to AI.
                    </span>
                  </p>
                </>
              )}
              <div className="ai-generate-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!state.canGenerate || generating || current || cooling}
                  onClick={generate}
                >
                  <Sparkles size={14} />
                  {current
                    ? "Saved overview is current"
                    : generating
                      ? "Generating overview…"
                      : "Send excerpts & generate overview"}
                </button>
                {generating && (
                  <button type="button" className="secondary-button" onClick={stop}>
                    <X size={13} />
                    Stop waiting
                  </button>
                )}
                {!generating && cooling && !current && (
                  <span role="status">
                    New requests available after {new Date(retryAt!).toLocaleTimeString()}.
                  </span>
                )}
              </div>
              {generating && (
                <p className="ai-status" role="status">
                  <LoaderCircle size={14} className="spinning" />
                  Generating and checking source references. This can take up to two minutes.
                  Leaving this tab stops waiting.
                </p>
              )}
            </div>
          )}
          {!state && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry loading overview
            </button>
          )}
          {report && (
            <div className="ai-report">
              {state?.stale && (
                <div className="map-stale" role="status">
                  Saved overview uses older evidence, policy, or model settings. It remains
                  available below; rebuild the map if needed, then generate an updated overview.
                </div>
              )}
              <div className="ai-report-meta">
                <span>
                  <BookOpen size={14} />
                  {state?.cacheHit
                    ? "Saved result reused · no new Gemini call"
                    : "Saved Gemini overview"}
                </span>
                <span>
                  Commit {report.commit.slice(0, 7)} · {new Date(report.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="ai-disclosure">
                AI interpretation. Source identifiers and excerpt bounds are checked; factual
                accuracy still needs review. Observed, inferred, and unknown are claim labels, not
                runtime verification.
              </p>
              <article className="ai-section">
                <h3>The core idea</h3>
                {claim(report.content.purpose)}
              </article>
              {report.content.stack.length > 0 && (
                <article className="ai-section">
                  <h3>Stack in the source</h3>
                  {report.content.stack.map((item, index) => (
                    <div key={index}>{claim(item)}</div>
                  ))}
                </article>
              )}
              {report.content.modules.length > 0 && (
                <article className="ai-section">
                  <h3>The main pieces</h3>
                  <div className="ai-module-grid">
                    {report.content.modules.map((item, index) => (
                      <div className="ai-module" key={index}>
                        <h4>{item.name}</h4>
                        {claim(item.explanation)}
                      </div>
                    ))}
                  </div>
                </article>
              )}
              {report.content.architecture.length > 0 && (
                <article className="ai-section">
                  <h3>How the pieces connect</h3>
                  {report.content.architecture.map((item, index) => (
                    <div key={index}>{claim(item)}</div>
                  ))}
                  <button className="secondary-button" type="button" onClick={onMap}>
                    Inspect the deterministic map
                    <ArrowUpRight size={13} />
                  </button>
                </article>
              )}
              <article className="ai-section">
                <h3>A useful reading order</h3>
                <ol className="ai-reading-order">
                  {report.content.readingOrder.map((item) => (
                    <li key={item.evidenceId}>
                      {citation(evidence.find((excerpt) => excerpt.id === item.evidenceId)!)}
                      {claim(item.reason)}
                    </li>
                  ))}
                </ol>
              </article>
              {report.content.concepts.length > 0 && (
                <article className="ai-section">
                  <h3>
                    Concepts to recognize <span>General programming knowledge</span>
                  </h3>
                  <div className="ai-module-grid">
                    {report.content.concepts.map((item, index) => (
                      <div key={index}>
                        <h4>{item.name}</h4>
                        <p>{item.explanation}</p>
                      </div>
                    ))}
                  </div>
                </article>
              )}
              <article className="ai-section ai-limits">
                <h3>What this overview cannot establish</h3>
                <ul>
                  {[...new Set([...report.content.limitations, ...report.limitations])].map(
                    (item, index) => (
                      <li key={index}>{item}</li>
                    ),
                  )}
                </ul>
                <p>
                  {report.evidence.length} excerpted files · {report.coverage.parsedFiles}/
                  {report.coverage.candidateFiles} source files parsed when generated
                </p>
              </article>
              <footer className="ai-report-footer">
                <span>
                  {report.modelVersion ?? report.model} · {report.promptVersion}
                </span>
                <span>
                  {(report.durationMs / 1000).toFixed(1)}s ·{" "}
                  {report.usage.inputTokens !== undefined
                    ? `${report.usage.inputTokens} input tokens`
                    : "Input usage not returned"}{" "}
                  ·{" "}
                  {report.usage.outputTokens !== undefined
                    ? `${report.usage.outputTokens} output tokens`
                    : "Output usage not returned"}
                  {report.usage.totalTokens !== undefined
                    ? ` · ${report.usage.totalTokens} total tokens`
                    : ""}
                </span>
              </footer>
            </div>
          )}
          {!report && !generating && (
            <div className="map-empty">
              <BookOpen size={28} />
              <h3>A guide to your first read.</h3>
              <p>
                Generate a saved overview to connect the project&apos;s purpose, main pieces, and
                code. Follow its references back to the source. Feature walkthroughs, questions, and
                exercises come in later phases.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
