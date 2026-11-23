import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
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
