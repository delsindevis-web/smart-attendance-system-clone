import { localParts, formatTime12 } from '../services/schedule.js';

export function registerStudentRoutes(r, app) {
  const { db, config } = app;

  // GET /api/student/dashboard  -> everything the Dashboard page shows
  r.get('/api/student/dashboard', ({ user }) => {
    const now = localParts(config);
    const courses = db.prepare(
      `SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id
       WHERE e.student_id = ? ORDER BY c.start_time`
    ).all(user.id);

    const todays = courses.filter((c) => c.days.split(',').map((d) => d.trim().toUpperCase()).includes(now.day));

    const classes = todays.map((c) => {
      const active = db.prepare(
        'SELECT code, id FROM sessions WHERE course_id = ? AND closed_at IS NULL AND ends_at > ? ORDER BY started_at DESC LIMIT 1'
      ).get(c.id, Date.now());
      const marked = active
        ? !!db.prepare('SELECT 1 FROM attendance WHERE session_id = ? AND student_id = ?').get(active.id, user.id)
        : false;
      return {
        courseId: c.id, code: c.code, name: c.name,
        startTime: c.start_time, endTime: c.end_time,
        timeLabel: `${formatTime12(c.start_time)} \u2013 ${formatTime12(c.end_time)}`,
        activeSessionCode: active?.code ?? null,   // null => teacher hasn't opened attendance yet
        canMarkAttendance: !!active && !marked,
        marked,
      };
    });

    const stats = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions s JOIN enrollments e ON e.course_id = s.course_id WHERE e.student_id = ?) AS total,
         (SELECT COUNT(*) FROM attendance WHERE student_id = ?) AS attended`
    ).get(user.id, user.id);

    const presentToday = db.prepare('SELECT marked_at FROM attendance WHERE student_id = ?').all(user.id)
      .filter((a) => localParts(config, new Date(a.marked_at)).date === now.date).length;

    return {
      student: { id: user.id, studentId: user.login_id, name: user.name },
      summary: {
        overallAttendance: stats.total ? Math.round((stats.attended / stats.total) * 100) : 0,
        classesToday: classes.length,
        presentToday,
      },
      classes,
    };
  }, { roles: ['student'] });

  // GET /api/student/attendance -> history, newest first
  r.get('/api/student/attendance', ({ user }) => {
    const rows = db.prepare(
      `SELECT c.name AS course, c.code AS courseCode, s.code AS session, a.marked_at, a.method
       FROM attendance a JOIN sessions s ON s.id = a.session_id JOIN courses c ON c.id = s.course_id
       WHERE a.student_id = ? ORDER BY a.marked_at DESC LIMIT 200`
    ).all(user.id);
    return { records: rows.map((x) => ({ ...x, marked_at: undefined, markedAt: new Date(x.marked_at).toISOString() })) };
  }, { roles: ['student'] });
}
