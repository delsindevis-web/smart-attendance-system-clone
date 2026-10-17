import { HttpError } from '../errors.js';
import { audit } from '../db.js';
import { currentQr } from '../services/qr.js';

export function registerTeacherRoutes(r, app) {
  const { db, config } = app;
  const teacher = { roles: ['teacher'] };

  const ownSession = (user, code) => {
    const s = db.prepare(
      `SELECT s.*, c.name AS course_name, c.code AS course_code FROM sessions s
       JOIN courses c ON c.id = s.course_id WHERE s.code = ?`
    ).get(code);
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (s.started_by !== user.id) throw new HttpError(403, 'FORBIDDEN', 'This is not your session.');
    return s;
  };
  const isOpen = (s) => s.closed_at == null && Date.now() < s.ends_at;
  const sessionView = (s) => ({
    code: s.code, course: { code: s.course_code, name: s.course_name },
    beaconId: s.beacon_id, open: isOpen(s),
    startedAt: new Date(s.started_at).toISOString(), endsAt: new Date(s.ends_at).toISOString(),
    closedAt: s.closed_at ? new Date(s.closed_at).toISOString() : null,
  });

  // GET /api/teacher/courses
  r.get('/api/teacher/courses', ({ user }) => {
    const rows = db.prepare('SELECT * FROM courses WHERE teacher_id = ? ORDER BY start_time').all(user.id);
    return {
      courses: rows.map((c) => {
        const active = db.prepare(
          'SELECT code FROM sessions WHERE course_id = ? AND closed_at IS NULL AND ends_at > ? ORDER BY started_at DESC LIMIT 1'
        ).get(c.id, Date.now());
        const students = db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?').get(c.id).n;
        return {
          id: c.id, code: c.code, name: c.name, startTime: c.start_time, endTime: c.end_time,
          days: c.days, beaconId: c.beacon_id, students, activeSessionCode: active?.code ?? null,
        };
      }),
    };
  }, teacher);

  // POST /api/sessions  { courseId, durationMinutes? (default 60), beaconId? }
  r.post('/api/sessions', ({ user, body }) => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ? AND teacher_id = ?').get(Number(body.courseId), user.id);
    if (!course) throw new HttpError(404, 'COURSE_NOT_FOUND', 'Course not found (or not yours).');
    const minutes = body.durationMinutes ?? 60;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
      throw new HttpError(400, 'VALIDATION_ERROR', '`durationMinutes` must be between 1 and 240.');
    }
    const open = db.prepare('SELECT code FROM sessions WHERE course_id = ? AND closed_at IS NULL AND ends_at > ?').get(course.id, Date.now());
    if (open) throw new HttpError(409, 'SESSION_ALREADY_OPEN', `Session ${open.code} is already open for this course.`);

    const n = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE course_id = ?').get(course.id).n + 1;
    const code = `${course.code}-${String(n).padStart(3, '0')}`;
    const now = Date.now();
    db.prepare(
      'INSERT INTO sessions (code, course_id, started_by, beacon_id, started_at, ends_at) VALUES (?,?,?,?,?,?)'
    ).run(code, course.id, user.id, String(body.beaconId || course.beacon_id), now, now + minutes * 60_000);
    audit(db, user.id, 'session_started', { code });
    return { status: 201, body: sessionView(ownSession(user, code)) };
  }, teacher);

  r.get('/api/sessions/:code', ({ user, params }) => sessionView(ownSession(user, params.code)), teacher);

  // GET /api/sessions/:code/qr  -> poll every ~5s; payload matches the original QR page
  r.get('/api/sessions/:code/qr', ({ user, params }) => {
    const s = ownSession(user, params.code);
    if (!isOpen(s)) throw new HttpError(409, 'SESSION_CLOSED', 'Session is closed.');
    return { ...currentQr(app, s), ttlSeconds: config.qrTtlSeconds };
  }, teacher);

  r.post('/api/sessions/:code/close', ({ user, params }) => {
    const s = ownSession(user, params.code);
    if (s.closed_at == null) db.prepare('UPDATE sessions SET closed_at = ? WHERE id = ?').run(Date.now(), s.id);
    audit(db, user.id, 'session_closed', { code: s.code });
    return sessionView(ownSession(user, params.code));
  }, teacher);

  // GET /api/sessions/:code/attendance -> full roster with present/absent
  r.get('/api/sessions/:code/attendance', ({ user, params }) => {
    const s = ownSession(user, params.code);
    const rows = db.prepare(
      `SELECT u.login_id, u.name, a.marked_at, a.method, a.ble_rssi, a.face_score
       FROM enrollments e JOIN users u ON u.id = e.student_id
       LEFT JOIN attendance a ON a.student_id = u.id AND a.session_id = ?
       WHERE e.course_id = ? ORDER BY u.login_id`
    ).all(s.id, s.course_id);
    const roster = rows.map((x) => ({
      studentId: x.login_id, name: x.name, present: x.marked_at != null,
      markedAt: x.marked_at ? new Date(x.marked_at).toISOString() : null,
      method: x.method ?? null, bleRssi: x.ble_rssi ?? null, faceScore: x.face_score ?? null,
    }));
    return {
      session: sessionView(s),
      summary: { enrolled: roster.length, present: roster.filter((x) => x.present).length },
      roster,
    };
  }, teacher);

  // PUT /api/sessions/:code/attendance/:studentId  { present: true|false }  (manual override)
  r.put('/api/sessions/:code/attendance/:studentId', ({ user, params, body }) => {
    const s = ownSession(user, params.code);
    if (typeof body.present !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', '`present` (true/false) is required.');
    const stu = db.prepare(
      `SELECT u.id FROM users u JOIN enrollments e ON e.student_id = u.id
       WHERE u.login_id = ? COLLATE NOCASE AND e.course_id = ?`
    ).get(params.studentId, s.course_id);
    if (!stu) throw new HttpError(404, 'STUDENT_NOT_FOUND', 'That student is not enrolled in this course.');
    if (body.present) {
      db.prepare(
        "INSERT INTO attendance (session_id, student_id, marked_at, method) VALUES (?,?,?,'manual') ON CONFLICT(session_id, student_id) DO NOTHING"
      ).run(s.id, stu.id, Date.now());
    } else {
      db.prepare('DELETE FROM attendance WHERE session_id = ? AND student_id = ?').run(s.id, stu.id);
    }
    audit(db, user.id, 'attendance_manual', { session: s.code, student: params.studentId, present: body.present });
    return { studentId: params.studentId, present: body.present };
  }, teacher);
}
