import Database from "better-sqlite3";
import { MAX_BLURB_LENGTH } from "../shared/types.js";

export type DB = Database.Database;

/**
 * Ordered list of migrations. Each runs once; progress is tracked in PRAGMA user_version.
 * Never edit a shipped migration — append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sparks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blurb      TEXT CHECK (blurb IS NULL OR length(blurb) <= ${MAX_BLURB_LENGTH}),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sparks_created_idx ON sparks (created_at DESC, id DESC);

  -- Images are uploaded before the spark is saved, so spark_id is NULL while pending.
  CREATE TABLE images (
    id         TEXT PRIMARY KEY,
    spark_id   INTEGER REFERENCES sparks (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,
    mime       TEXT NOT NULL,
    ext        TEXT NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX images_spark_idx ON images (spark_id, position);

  -- Trigram tokenizer gives substring matching (e.g. "kube" -> "kubernetes", parts of URLs).
  CREATE VIRTUAL TABLE sparks_fts USING fts5 (
    blurb,
    content = 'sparks',
    content_rowid = 'id',
    tokenize = 'trigram'
  );
  CREATE TRIGGER sparks_ai AFTER INSERT ON sparks BEGIN
    INSERT INTO sparks_fts (rowid, blurb) VALUES (new.id, new.blurb);
  END;
  CREATE TRIGGER sparks_ad AFTER DELETE ON sparks BEGIN
    INSERT INTO sparks_fts (sparks_fts, rowid, blurb) VALUES ('delete', old.id, old.blurb);
  END;
  CREATE TRIGGER sparks_au AFTER UPDATE OF blurb ON sparks BEGIN
    INSERT INTO sparks_fts (sparks_fts, rowid, blurb) VALUES ('delete', old.id, old.blurb);
    INSERT INTO sparks_fts (rowid, blurb) VALUES (new.id, new.blurb);
  END;
  `,
];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
