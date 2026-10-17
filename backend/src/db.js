import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  login_id      TEXT NOT NULL UNIQUE,           -- student ID / teacher ID
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('student','teacher')),
  password_hash TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,              -- e.g. CS301
  name       TEXT NOT NULL,                     -- e.g. Computer Networks
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  start_time TEXT NOT NULL,                     -- HH:MM (24h)
  end_time   TEXT NOT NULL,
  days       TEXT NOT NULL,                     -- MON,TUE,...
  beacon_id  TEXT NOT NULL                      -- classroom BLE beacon identifier
);

CREATE TABLE IF NOT EXISTS enrollments (
  course_id  INTEGER NOT NULL REFERENCES courses(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (course_id, student_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,              -- e.g. CS301-004 (shown in the QR)
  course_id  INTEGER NOT NULL REFERENCES courses(id),
  started_by INTEGER NOT NULL REFERENCES users(id),
  beacon_id  TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  closed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS qr_tokens (
  token      TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_session ON qr_tokens(session_id, expires_at);

CREATE TABLE IF NOT EXISTS attempts (
  id         TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  ble_at     INTEGER,
  ble_rssi   INTEGER,
  qr_at      INTEGER,
  face_at    INTEGER,
  face_score REAL
);
CREATE INDEX IF NOT EXISTS idx_attempt_student ON attempts(student_id, session_id);

CREATE TABLE IF NOT EXISTS liveness_challenges (
  id         TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  nonce      TEXT NOT NULL,
  actions    TEXT NOT NULL,                     -- JSON array, e.g. ["blink","turn_left"]
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  marked_at  INTEGER NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('verified','manual')),
  ble_rssi   INTEGER,
  face_score REAL,
  UNIQUE (session_id, student_id)               -- one record per student per session
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  user_id INTEGER,
  event   TEXT NOT NULL,
  detail  TEXT
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function audit(db, userId, event, detail) {
  db.prepare('INSERT INTO audit_log (ts, user_id, event, detail) VALUES (?,?,?,?)')
    .run(Date.now(), userId ?? null, event, detail ? JSON.stringify(detail) : null);
}
