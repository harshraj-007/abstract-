import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { StructuralAnalysis } from "@/lib/contracts/analysis";
import type { OverviewReport } from "@/lib/contracts/overview";
import type { QuestionReport, QuestionSummary } from "@/lib/contracts/questions";
import type {
  RepositorySnapshot,
  SnapshotSummary,
  SourceEntry,
  SourceFile,
} from "@/lib/contracts/repository";

export class SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_files (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, file_id)
      );
      CREATE TABLE IF NOT EXISTS structural_analyses (
        snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS overview_reports (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        document TEXT NOT NULL,
        UNIQUE(snapshot_id, cache_key)
      );
      CREATE TABLE IF NOT EXISTS question_answers (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        document TEXT NOT NULL,
        UNIQUE(snapshot_id,cache_key)
      );
    `);
  }

  saveSnapshot(snapshot: RepositorySnapshot) {
    this.db
      .prepare("INSERT INTO snapshots (id, created_at, document) VALUES (?, ?, ?)")
      .run(snapshot.id, snapshot.createdAt, JSON.stringify(snapshot));
  }

  getSnapshot(id: string): RepositorySnapshot | null {
    const row = this.db.prepare("SELECT document FROM snapshots WHERE id = ?").get(id) as
      { document: string } | undefined;
    return row ? (JSON.parse(row.document) as RepositorySnapshot) : null;
  }

  recent(): SnapshotSummary[] {
    const rows = this.db
      .prepare("SELECT document FROM snapshots ORDER BY created_at DESC LIMIT 12")
      .all() as { document: string }[];
    return rows.map(({ document }) => {
      const { id, owner, name, commit, createdAt, language } = JSON.parse(
        document,
      ) as RepositorySnapshot;
      return { id, owner, name, commit, createdAt, language };
    });
  }

  getSource(snapshotId: string, fileId: string): SourceFile | null {
    const row = this.db
      .prepare("SELECT document FROM source_files WHERE snapshot_id = ? AND file_id = ?")
      .get(snapshotId, fileId) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as SourceFile) : null;
  }

  allSources(snapshotId: string): SourceFile[] {
    const rows = this.db
      .prepare("SELECT document FROM source_files WHERE snapshot_id = ? ORDER BY file_id")
      .all(snapshotId) as { document: string }[];
    return rows.map((row) => JSON.parse(row.document) as SourceFile);
  }

  getAnalysis(snapshotId: string): StructuralAnalysis | null {
    const row = this.db
      .prepare("SELECT document FROM structural_analyses WHERE snapshot_id = ?")
      .get(snapshotId) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as StructuralAnalysis) : null;
  }

  saveAnalysis(analysis: StructuralAnalysis) {
    this.db
      .prepare("INSERT OR REPLACE INTO structural_analyses (snapshot_id, document) VALUES (?, ?)")
      .run(analysis.snapshotId, JSON.stringify(analysis));
  }

  getOverview(snapshotId: string, cacheKey?: string): OverviewReport | null {
    const row = (
      cacheKey
        ? this.db
            .prepare(
              "SELECT document FROM overview_reports WHERE snapshot_id = ? AND cache_key = ?",
            )
            .get(snapshotId, cacheKey)
        : this.db
            .prepare(
              "SELECT document FROM overview_reports WHERE snapshot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            )
            .get(snapshotId)
    ) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as OverviewReport) : null;
  }

  saveOverview(report: OverviewReport) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO overview_reports (id,snapshot_id,cache_key,created_at,document) VALUES (?,?,?,?,?)",
      )
      .run(report.id, report.snapshotId, report.cacheKey, report.createdAt, JSON.stringify(report));
    // Keep bounded local history per snapshot; a failed generation never reaches this method.
    this.db
      .prepare(
        "DELETE FROM overview_reports WHERE snapshot_id = ? AND id NOT IN (SELECT id FROM overview_reports WHERE snapshot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5)",
      )
      .run(report.snapshotId, report.snapshotId);
  }

  updateEntry(
    snapshotId: string,
    fileId: string,
    update: Partial<Pick<SourceEntry, "status" | "reason" | "detail">>,
  ) {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) throw new Error("Snapshot no longer exists.");
    const entry = snapshot.files.find((file) => file.id === fileId);
    if (!entry) throw new Error("Source entry no longer exists.");
    Object.assign(entry, update);
    this.db
      .prepare("UPDATE snapshots SET document = ? WHERE id = ?")
      .run(JSON.stringify(snapshot), snapshotId);
    return snapshot;
  }

  getQuestion(
    snapshotId: string,
    lookup: { id: string } | { cacheKey: string },
  ): QuestionReport | null {
    const row = (
      "id" in lookup
        ? this.db
            .prepare("SELECT document FROM question_answers WHERE snapshot_id = ? AND id = ?")
            .get(snapshotId, lookup.id)
        : this.db
            .prepare(
              "SELECT document FROM question_answers WHERE snapshot_id = ? AND cache_key = ?",
            )
            .get(snapshotId, lookup.cacheKey)
    ) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as QuestionReport) : null;
  }
  recentQuestions(snapshotId: string): QuestionSummary[] {
    const rows = this.db
      .prepare(
        "SELECT document FROM question_answers WHERE snapshot_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 20",
      )
      .all(snapshotId) as { document: string }[];
    return rows.map(({ document }) => {
      const { id, createdAt, draft, path, model } = JSON.parse(document) as QuestionReport;
      return { id, createdAt, draft, path, model };
    });
  }
  saveQuestion(report: QuestionReport) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO question_answers (id,snapshot_id,cache_key,created_at,document) VALUES (?,?,?,?,?)",
      )
      .run(report.id, report.snapshotId, report.cacheKey, report.createdAt, JSON.stringify(report));
    this.db
      .prepare(
        "DELETE FROM question_answers WHERE snapshot_id = ? AND id NOT IN (SELECT id FROM question_answers WHERE snapshot_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 20)",
      )
      .run(report.snapshotId, report.snapshotId);
  }

  saveSource(source: SourceFile) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO source_files (snapshot_id, file_id, document) VALUES (?, ?, ?)",
        )
        .run(source.snapshotId, source.fileId, JSON.stringify(source));
      this.updateEntry(source.snapshotId, source.fileId, {
        status: "fetched",
        reason: undefined,
        detail: undefined,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSnapshot(id: string) {
    this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);
  }

  close() {
    this.db.close();
  }
}

let store: SnapshotStore | undefined;

export function getStore() {
  // This is a runtime data location, never a source asset to bundle or trace.
  store ??= new SnapshotStore(
    path.join(
      path.resolve(/* turbopackIgnore: true */ process.env.ABSTRACT_DATA_DIR || ".abstract"),
      "abstract.sqlite",
    ),
  );
  return store;
}
