import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { audit, tx } from '../db.js';
import { checkBle } from './ble.js';
import { checkQrToken } from './qr.js';
import { issueChallenge, verifyLiveness } from './liveness.js';

const isOpen = (s, now = Date.now()) => s.closed_at == null && now < s.ends_at;

export function findSession(app, { sessionCode, courseId }) {
  const { db } = app;
  if (sessionCode) return db.prepare('SELECT * FROM sessions WHERE code = ?').get(String(sessionCode));
  if (courseId != null) {
    return db.prepare(
      'SELECT * FROM sessions WHERE course_id = ? AND closed_at IS NULL AND ends_at > ? ORDER BY started_at DESC LIMIT 1'
    ).get(Number(courseId), Date.now());
  }
  return undefined;
}

const courseOf = (app, session) =>
  app.db.prepare('SELECT id, code, name FROM courses WHERE id = ?').get(session.course_id);

export function attemptView(app, a, session) {
  return {
    attemptId: a.id,
    status: a.status,
    session: { code: session.code, course: courseOf(app, session) },
    requiredFactors: app.config.requiredFactors,
    verified: { ble: a.ble_at != null, qr: a.qr_at != null, face: a.face_at != null },
    expiresAt: new Date(a.expires_at).toISOString(),
  };
}

/** Step 0: student taps "Mark Attendance". */
export function startAttempt(app, user, body) {
  const { db, config } = app;
  const session = findSession(app, body);
  if (!session) {
    throw new HttpError(404, 'NO_ACTIVE_SESSION', 'No attendance session is open for this class right now.');
  }
  if (!isOpen(session)) throw new HttpError(409, 'SESSION_CLOSED', 'Attendance for this session is closed.');

  const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(session.course_id, user.id);
  if (!enrolled) throw new HttpError(403, 'NOT_ENROLLED', 'You are not enrolled in this course.');

  const done = db.prepare('SELECT 1 FROM attendance WHERE session_id = ? AND student_id = ?').get(session.id, user.id);
  if (done) throw new HttpError(409, 'ALREADY_MARKED', 'Your attendance is already marked for this session.');

  // Resume an unfinished attempt instead of creating duplicates (e.g. page refresh)
  let attempt = db.prepare(
    "SELECT * FROM attempts WHERE session_id = ? AND student_id = ? AND status = 'in_progress' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
  ).get(session.id, user.id, Date.now());

  if (!attempt) {
    const now = Date.now();
    attempt = {
      id: crypto.randomUUID(), session_id: session.id, student_id: user.id,
      created_at: now, expires_at: now + config.attemptTtlMinutes * 60_000,
      status: 'in_progress', ble_at: null, qr_at: null, face_at: null,
    };
    db.prepare('INSERT INTO attempts (id, session_id, student_id, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(attempt.id, attempt.session_id, attempt.student_id, attempt.created_at, attempt.expires_at);
  }
  return attemptView(app, attempt, session);
}

/** Load an attempt owned by this student and make sure it can still be worked on. */
export function loadAttempt(app, user, attemptId) {
  const { db } = app;
  const a = db.prepare('SELECT * FROM attempts WHERE id = ? AND student_id = ?').get(attemptId, user.id);
  if (!a) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Attendance attempt not found.');
  if (a.status !== 'in_progress') throw new HttpError(409, 'ATTEMPT_CLOSED', 'This attempt is already completed.');
  if (Date.now() > a.expires_at) {
    throw new HttpError(410, 'ATTEMPT_EXPIRED', 'This attempt timed out. Please start again.');
  }
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(a.session_id);
  if (!isOpen(session)) throw new HttpError(409, 'SESSION_CLOSED', 'Attendance for this session is closed.');
  return { a, session };
}

function requireFactor(app, factor) {
  if (!app.config.requiredFactors.includes(factor)) {
    throw new HttpError(400, 'FACTOR_NOT_REQUIRED', `The "${factor}" check is not enabled on this server.`);
  }
}

/** Run a verification step; log failures so suspicious patterns are visible. */
async function guarded(app, user, a, factor, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      audit(app.db, user.id, `verify_failed:${factor}`, { attempt: a.id, code: err.code });
    }
    throw err;
  }
}

export async function submitBle(app, user, attemptId, body) {
  requireFactor(app, 'ble');
  const { a, session } = loadAttempt(app, user, attemptId);
  const { rssi } = await guarded(app, user, a, 'ble', () => checkBle(app, session, body));
  app.db.prepare('UPDATE attempts SET ble_at = ?, ble_rssi = ? WHERE id = ?').run(Date.now(), rssi, a.id);
  return attemptView(app, { ...a, ble_at: Date.now(), ble_rssi: rssi }, session);
}

export async function submitQr(app, user, attemptId, body) {
  requireFactor(app, 'qr');
  const { a, session } = loadAttempt(app, user, attemptId);
  await guarded(app, user, a, 'qr', () => checkQrToken(app, session, body.token));
  app.db.prepare('UPDATE attempts SET qr_at = ? WHERE id = ?').run(Date.now(), a.id);
  return attemptView(app, { ...a, qr_at: Date.now() }, session);
}

export function startLiveness(app, user, attemptId) {
  requireFactor(app, 'face');
  const { a } = loadAttempt(app, user, attemptId);
  return issueChallenge(app, a);
}

export async function submitLiveness(app, user, attemptId, body) {
  requireFactor(app, 'face');
  const { a, session } = loadAttempt(app, user, attemptId);
  const { score } = await guarded(app, user, a, 'face', () => verifyLiveness(app, a, body));
  app.db.prepare('UPDATE attempts SET face_at = ?, face_score = ? WHERE id = ?').run(Date.now(), score, a.id);
  return attemptView(app, { ...a, face_at: Date.now(), face_score: score }, session);
}

/** Final step: every required proof must be present, then the record is written. */
export function completeAttempt(app, user, attemptId) {
  const { db, config } = app;
  const { a, session } = loadAttempt(app, user, attemptId);
  const have = { ble: a.ble_at != null, qr: a.qr_at != null, face: a.face_at != null };
  const missing = config.requiredFactors.filter((f) => !have[f]);
  if (missing.length) {
    throw new HttpError(409, 'VERIFICATION_INCOMPLETE', `Still need: ${missing.join(', ')}.`, { missing });
  }
  const markedAt = Date.now();
  tx(db, () => {
    try {
      db.prepare(
        'INSERT INTO attendance (session_id, student_id, marked_at, method, ble_rssi, face_score) VALUES (?,?,?,?,?,?)'
      ).run(session.id, user.id, markedAt, 'verified', a.ble_rssi ?? null, a.face_score ?? null);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'ALREADY_MARKED', 'Your attendance is already marked for this session.');
      throw err;
    }
    db.prepare("UPDATE attempts SET status = 'completed' WHERE id = ?").run(a.id);
  });
  audit(db, user.id, 'attendance_marked', { session: session.code });
  return {
    status: 'present',
    markedAt: new Date(markedAt).toISOString(),
    session: { code: session.code, course: courseOf(app, session) },
    verified: have,
  };
}
