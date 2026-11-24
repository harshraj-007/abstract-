"use client";

import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  FileCode2,
  LoaderCircle,
  ShieldCheck,
  AlertCircle,
  RefreshCw,
  MessageCircle,
} from "lucide-react";
import {
  sourceLines,
  sourceUrl,
  type ApiError,
  type RepositorySnapshot,
  type SourceEntry,
  type SourceFile,
} from "@/lib/contracts/repository";

function HighlightedLine({ line, enabled }: { line: string; enabled: boolean }) {
  if (!enabled) return <>{line || " "}</>;
  // Decorative token coloring only. Source stays escaped React text; nothing is executed.
  const parts = line.split(
    /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:import|from|export|default|const|let|var|function|async|await|return|if|else|throw|new|class|extends|type|interface|public|private|readonly|try|catch|finally|for|of|in|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g,
  );
  return (
    <>
      {parts.map((part, index) => {
        const kind = part.startsWith("//")
          ? "comment"
          : /^["'`]/.test(part)
            ? "string"
            : /^\d/.test(part)
              ? "number"
              : /^(import|from|export|default|const|let|var|function|async|await|return|if|else|throw|new|class|extends|type|interface|public|private|readonly|try|catch|finally|for|of|in|true|false|null|undefined)$/.test(
                    part,
                  )
                ? "keyword"
                : undefined;
        return (
          <span key={index} className={kind ? `token-${kind}` : undefined}>
            {part}
          </span>
        );
      })}
    </>
  );
}

export function SourceViewer({
  snapshot,
  file,
  source,
  loading,
  error,
  selectedLine,
  onLine,
  onRetry,
  onAsk,
}: {
  snapshot: RepositorySnapshot;
  file: SourceEntry | undefined;
  source: SourceFile | null;
  loading: boolean;
  error: ApiError | null;
  selectedLine: number | null;
  onLine: (line: number) => void;
  onRetry: () => void;
  onAsk: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [lineInput, setLineInput] = useState("");
  const [lineError, setLineError] = useState("");
  const usableSource = source && source.fileId === file?.id ? source : null;
  const syntax = Boolean(file && /\.[cm]?[jt]sx?$|\.json$/.test(file.path));

  useEffect(() => {
    if (usableSource && selectedLine)
      document.getElementById(`source-line-${selectedLine}`)?.scrollIntoView({ block: "nearest" });
  }, [usableSource, selectedLine]);

  async function copy() {
    if (!usableSource) return;
    try {
      await navigator.clipboard.writeText(usableSource.content);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError(true);
    }
  }

  function jump(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const line = Number(lineInput);
    if (!Number.isInteger(line) || line < 1 || line > (usableSource?.lineCount ?? 0)) {
      setLineError(`Use a line from 1 to ${usableSource?.lineCount ?? 0}.`);
      return;
    }
    setLineError("");
    onLine(line);
    document
      .getElementById(`source-line-${line}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  return (
    <section className="source-viewer" aria-label="Source viewer" aria-busy={loading}>
      <div className="source-toolbar">
        <div className="source-path">
          <FileCode2 size={16} />
          <span>{file?.path ?? "Select a file"}</span>
        </div>
        {file && (
          <div className="source-actions">
            <button
              type="button"
              className="icon-button"
              disabled={!usableSource}
              onClick={onAsk}
              aria-label="Ask about this code"
              title="Ask about this code"
            >
              <MessageCircle size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={copy}
              disabled={!usableSource}
              aria-label={copied ? "Source copied" : "Copy source"}
              title={
                copyError
                  ? "Clipboard unavailable; select and copy the source manually."
                  : "Copy source"
              }
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <a
              className="icon-button"
              href={sourceUrl(snapshot, file.path, selectedLine ?? undefined)}
              target="_blank"
              rel="noreferrer"
              aria-label="Open this file at the pinned commit on GitHub"
              title="View pinned source on GitHub"
            >
              <ArrowUpRight size={17} />
            </a>
          </div>
        )}
      </div>
      {usableSource && (
        <div className="source-meta">
          <span>
            {usableSource.lineCount} lines <span className="meta-dot">·</span>{" "}
            {formatBytes(file?.size ?? 0)} <span className="meta-dot">·</span> UTF-8
          </span>
          <form onSubmit={jump} className="line-jump">
            <label htmlFor="jump-line">Go to line</label>
            <input
              id="jump-line"
              type="number"
              min="1"
              max={usableSource.lineCount || 1}
              value={lineInput}
              onChange={(event) => setLineInput(event.target.value)}
              placeholder="#"
            />
            <button type="submit" aria-label="Jump to line">
              ↵
            </button>
          </form>
        </div>
      )}
      {lineError && usableSource && (
        <p className="inline-warning" role="alert">
          {lineError}
        </p>
      )}
      {copyError && (
        <p className="inline-warning" role="alert">
          Clipboard unavailable. Select and copy the source manually.
        </p>
      )}
      <div className="source-scroll" tabIndex={0} aria-label="Scrollable source code">
        {loading ? (
          <div className="viewer-state">
            <LoaderCircle size={24} className="spin" />
            <h3>Opening source</h3>
            <p>Fetching this file from commit {snapshot.commit.slice(0, 7)}.</p>
          </div>
        ) : error ? (
          <div className="viewer-state">
            <AlertCircle size={26} />
            <h3>Couldn’t open this file</h3>
            <p>{error.message}</p>
            {error.retryAt && <p>Retry after {new Date(error.retryAt).toLocaleTimeString()}.</p>}
            <button type="button" className="secondary-button" onClick={onRetry}>
              <RefreshCw size={14} />
              Try again
            </button>
          </div>
        ) : file?.status === "skipped" ? (
          <div className="viewer-state">
            <ShieldCheck size={28} />
            <span className="eyebrow">EXCLUDED FROM THIS SNAPSHOT</span>
            <h3>
              {file.reason === "sensitive"
                ? "A little privacy by design."
                : "This file stays outside the reading list."}
            </h3>
            <p>{file.detail}</p>
            <p className="small-muted">
              The file is listed for coverage. Its contents are not stored or displayed.
            </p>
          </div>
        ) : usableSource ? (
          usableSource.content.length ? (
            <pre className="code-block">
              <code>
                {sourceLines(usableSource.content).map((line, index) => (
                  <span
                    key={index}
                    id={`source-line-${index + 1}`}
                    className={`code-line ${selectedLine === index + 1 ? "highlighted-line" : ""}`}
                  >
                    <button
                      type="button"
                      className="line-number"
                      onClick={() => onLine(index + 1)}
                      aria-label={`Select line ${index + 1}`}
                      aria-pressed={selectedLine === index + 1}
                    >
                      {index + 1}
                    </button>
                    <span className="line-text">
                      <HighlightedLine line={line} enabled={syntax} />
                    </span>
                  </span>
                ))}
              </code>
            </pre>
          ) : (
            <div className="viewer-state">
              <FileCode2 size={26} />
              <h3>An empty file.</h3>
              <p>This file exists at the pinned commit and contains no text.</p>
            </div>
          )
        ) : (
          <div className="viewer-state">
            <FileCode2 size={28} />
            <h3>Start with a file.</h3>
            <p>
              Choose a readable file from the explorer to see its source and stable line references.
            </p>
          </div>
        )}
      </div>
      {usableSource && (
        <div className="source-footer">
          <ShieldCheck size={13} />
          <span>
            Verified Git object <span className="meta-dot">·</span> SHA-256{" "}
            {usableSource.contentHash.slice(0, 12)}
          </span>
          <span className="source-footer-note">Source only. Never executed.</span>
        </div>
      )}
    </section>
  );
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
