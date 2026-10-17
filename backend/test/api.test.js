import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { hashPassword } from '../src/auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(overrides = {}) {
  const { app, server } = createApp({
    dbPath: ':memory:', quiet: true, livenessMinResponseMs: 0, requiredFactors: ['ble', 'face'], ...overrides,
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const login = async (loginId, password) => (await call('POST', '/api/auth/login', { body: { loginId, password } })).body.token;
  return { app, call, login, close: () => new Promise((r) => server.close(() => { app.db.close(); r(); })) };
}

/** Teacher opens a session for Computer Networks; returns ids/tokens. */
async function openSession(t) {
  const teacher = await t.login('T001', 'teacher123');
  const courses = (await t.call('GET', '/api/teacher/courses', { token: teacher })).body.courses;
  const cn = courses.find((c) => c.code === 'CN301');
  const s = await t.call('POST', '/api/sessions', { token: teacher, body: { courseId: cn.id } });
  assert.equal(s.status, 201);
  return { teacher, course: cn, code: s.body.code };
}

async function passLiveness(t, token, attemptId, score = 0.95) {
  const ch = (await t.call('POST', `/api/attendance/attempts/${attemptId}/liveness/challenge`, { token })).body;
  return t.call('POST', `/api/attendance/attempts/${attemptId}/liveness`, {
    token, body: { challengeId: ch.challengeId, nonce: ch.nonce, passed: true, score },
  });
}

test('health + unknown route', async () => {
  const t = await boot();
  assert.equal((await t.call('GET', '/api/health')).body.status, 'ok');
  assert.equal((await t.call('GET', '/api/nope')).status, 404);
  await t.close();
});

test('auth: student ID-only login, teacher needs password, roles enforced', async () => {
  const t = await boot();
  const ok = await t.call('POST', '/api/auth/login', { body: { studentId: '23BCS001' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'student');

  assert.equal((await t.call('POST', '/api/auth/login', { body: { studentId: 'NOPE' } })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { loginId: 'T001' } })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { loginId: 'T001', password: 'bad' } })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: {} })).status, 400);

  assert.equal((await t.call('GET', '/api/student/dashboard')).status, 401);
  assert.equal((await t.call('GET', '/api/teacher/courses', { token: ok.body.token })).status, 403);
  assert.equal((await t.call('GET', '/api/auth/me', { token: ok.body.token })).body.user.loginId, '23BCS001');
  assert.equal((await t.call('GET', '/api/auth/me', { token: ok.body.token + 'x' })).status, 401);
  await t.close();
});

test('REQUIRE_PASSWORD=true makes students need a password too', async () => {
  const t = await boot({ requirePassword: true });
  assert.equal((await t.call('POST', '/api/auth/login', { body: { studentId: '23BCS001' } })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { studentId: '23BCS001', password: 'student123' } })).status, 200);
  await t.close();
});

test('full BLE + face flow records attendance exactly once', async () => {
  const t = await boot();
  const { teacher, course, code } = await openSession(t);
  const stu = await t.login('23BCS001');

  const dash = (await t.call('GET', '/api/student/dashboard', { token: stu })).body;
  const cn = dash.classes.find((c) => c.code === 'CN301');
  assert.equal(cn.activeSessionCode, code);
  assert.equal(cn.canMarkAttendance, true);
  assert.equal(dash.summary.presentToday, 0);

  const start = await t.call('POST', '/api/attendance/attempts', { token: stu, body: { courseId: course.id } });
  assert.equal(start.status, 201);
  const id = start.body.attemptId;
  const A = (p) => `/api/attendance/attempts/${id}${p}`;

  // BLE: wrong beacon, too far, then good
  let r = await t.call('POST', A('/ble'), { token: stu, body: { beaconId: 'BLE-OTHER', rssi: -50 } });
  assert.equal(r.body.error.code, 'BLE_BEACON_MISMATCH');
  r = await t.call('POST', A('/ble'), { token: stu, body: { beaconId: 'BLE-CN301', rssi: -95 } });
  assert.equal(r.body.error.code, 'BLE_TOO_FAR');
  r = await t.call('POST', A('/ble'), { token: stu, body: { beaconId: 'ble-cn301', rssi: -60 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.verified, { ble: true, qr: false, face: false });

  // QR not enabled in this config
  assert.equal((await t.call('POST', A('/qr'), { token: stu, body: { token: 'x' } })).body.error.code, 'FACTOR_NOT_REQUIRED');

  // cannot complete yet
  r = await t.call('POST', A('/complete'), { token: stu });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.error.details.missing, ['face']);

  // liveness: low score fails, challenge can't be reused, fresh challenge passes
  const ch = (await t.call('POST', A('/liveness/challenge'), { token: stu })).body;
  assert.equal(ch.actions.length, 2);
  r = await t.call('POST', A('/liveness'), { token: stu, body: { challengeId: ch.challengeId, nonce: ch.nonce, passed: true, score: 0.4 } });
  assert.equal(r.body.error.code, 'LIVENESS_FAILED');
  r = await t.call('POST', A('/liveness'), { token: stu, body: { challengeId: ch.challengeId, nonce: ch.nonce, passed: true, score: 0.99 } });
  assert.equal(r.body.error.code, 'LIVENESS_CHALLENGE_USED');
  r = await t.call('POST', A('/liveness'), { token: stu, body: { challengeId: ch.challengeId, nonce: 'wrong', passed: true, score: 0.99 } });
  assert.equal(r.body.error.code, 'LIVENESS_CHALLENGE_INVALID');
  assert.equal((await passLiveness(t, stu, id)).status, 200);

  r = await t.call('POST', A('/complete'), { token: stu });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'present');
  assert.equal(r.body.session.course.name, 'Computer Networks');

  // second tap is rejected, dashboard + roster reflect it
  r = await t.call('POST', '/api/attendance/attempts', { token: stu, body: { courseId: course.id } });
  assert.equal(r.body.error.code, 'ALREADY_MARKED');
  const after = (await t.call('GET', '/api/student/dashboard', { token: stu })).body;
  assert.equal(after.summary.presentToday, 1);
  assert.equal(after.summary.overallAttendance, 100);
  assert.equal(after.classes.find((c) => c.code === 'CN301').marked, true);

  const roster = (await t.call('GET', `/api/sessions/${code}/attendance`, { token: teacher })).body;
  assert.equal(roster.summary.present, 1);
  assert.equal(roster.summary.enrolled, 5);
  assert.equal((await t.call('GET', '/api/student/attendance', { token: stu })).body.records.length, 1);
  await t.close();
});

test('students cannot use another student\'s attempt, or an unenrolled course', async () => {
  const t = await boot();
  const { course } = await openSession(t);
  const a = await t.login('23BCS001');
  const b = await t.login('23BCS002');
  const att = (await t.call('POST', '/api/attendance/attempts', { token: a, body: { courseId: course.id } })).body;
  const steal = await t.call('POST', `/api/attendance/attempts/${att.attemptId}/ble`, { token: b, body: { beaconId: 'BLE-CN301', rssi: -50 } });
  assert.equal(steal.status, 404);

  t.app.db.prepare("INSERT INTO users (login_id,name,role,created_at) VALUES ('99XXX','Outsider','student',1)").run();
  const out = await t.login('99XXX');
  const r = await t.call('POST', '/api/attendance/attempts', { token: out, body: { courseId: course.id } });
  assert.equal(r.body.error.code, 'NOT_ENROLLED');
  await t.close();
});

test('dynamic QR: rotates, validates, expires', async () => {
  const t = await boot({ requiredFactors: ['ble', 'qr', 'face'], qrTtlSeconds: 0.4, qrGraceSeconds: 0 });
  const { teacher, course, code } = await openSession(t);
  const stu = await t.login('23BCS003');
  const id = (await t.call('POST', '/api/attendance/attempts', { token: stu, body: { sessionCode: code } })).body.attemptId;
  const A = (p) => `/api/attendance/attempts/${id}${p}`;

  const q1 = (await t.call('GET', `/api/sessions/${code}/qr`, { token: teacher })).body;
  assert.equal(q1.sessionId, code);
  assert.ok(q1.token && q1.issuedAt && q1.expiresAt);
  const q1b = (await t.call('GET', `/api/sessions/${code}/qr`, { token: teacher })).body;
  assert.equal(q1b.token, q1.token, 'same token inside its lifetime');

  assert.equal((await t.call('POST', A('/qr'), { token: stu, body: { token: 'fake' } })).body.error.code, 'QR_INVALID');
  assert.equal((await t.call('POST', A('/qr'), { token: stu, body: { token: q1.token } })).status, 200);

  await sleep(500);
  const q2 = (await t.call('GET', `/api/sessions/${code}/qr`, { token: teacher })).body;
  assert.notEqual(q2.token, q1.token, 'rotated after expiry');
  assert.equal((await t.call('POST', A('/qr'), { token: stu, body: { token: q1.token } })).body.error.code, 'QR_EXPIRED');

  // all three factors required before completion
  await t.call('POST', A('/ble'), { token: stu, body: { beaconId: 'BLE-CN301', rssi: -55 } });
  assert.equal((await t.call('POST', A('/complete'), { token: stu })).body.error.code, 'VERIFICATION_INCOMPLETE');
  await passLiveness(t, stu, id);
  assert.equal((await t.call('POST', A('/complete'), { token: stu })).status, 200);
  await t.close();
});

test('liveness answered too fast is rejected', async () => {
  const t = await boot({ livenessMinResponseMs: 5000 });
  const { course } = await openSession(t);
  const stu = await t.login('23BCS004');
  const id = (await t.call('POST', '/api/attendance/attempts', { token: stu, body: { courseId: course.id } })).body.attemptId;
  const r = await passLiveness(t, stu, id);
  assert.equal(r.body.error.code, 'LIVENESS_TOO_FAST');
  await t.close();
});

test('session lifecycle: ownership, duplicate open, close, manual override', async () => {
  const t = await boot();
  const { teacher, course, code } = await openSession(t);

  const dup = await t.call('POST', '/api/sessions', { token: teacher, body: { courseId: course.id } });
  assert.equal(dup.body.error.code, 'SESSION_ALREADY_OPEN');

  t.app.db.prepare("INSERT INTO users (login_id,name,role,password_hash,created_at) VALUES ('T002','Other','teacher',?,1)").run(hashPassword('pw'));
  const other = await t.login('T002', 'pw');
  assert.equal((await t.call('GET', `/api/sessions/${code}/qr`, { token: other })).status, 403);

  const man = await t.call('PUT', `/api/sessions/${code}/attendance/23BCS005`, { token: teacher, body: { present: true } });
  assert.equal(man.status, 200);
  let roster = (await t.call('GET', `/api/sessions/${code}/attendance`, { token: teacher })).body;
  assert.equal(roster.roster.find((x) => x.studentId === '23BCS005').method, 'manual');
  await t.call('PUT', `/api/sessions/${code}/attendance/23BCS005`, { token: teacher, body: { present: false } });
  roster = (await t.call('GET', `/api/sessions/${code}/attendance`, { token: teacher })).body;
  assert.equal(roster.summary.present, 0);

  const stu = await t.login('23BCS001');
  const id = (await t.call('POST', '/api/attendance/attempts', { token: stu, body: { courseId: course.id } })).body.attemptId;

  const closed = await t.call('POST', `/api/sessions/${code}/close`, { token: teacher });
  assert.equal(closed.body.open, false);
  assert.equal((await t.call('POST', `/api/attendance/attempts/${id}/ble`, { token: stu, body: { beaconId: 'BLE-CN301', rssi: -50 } })).body.error.code, 'SESSION_CLOSED');
  assert.equal((await t.call('POST', '/api/attendance/attempts', { token: stu, body: { courseId: course.id } })).body.error.code, 'NO_ACTIVE_SESSION');
  assert.equal((await t.call('POST', '/api/attendance/attempts', { token: stu, body: { sessionCode: code } })).body.error.code, 'SESSION_CLOSED');
  assert.equal((await t.call('GET', `/api/sessions/${code}/qr`, { token: teacher })).status, 409);

  // a new session gets the next number
  const next = await t.call('POST', '/api/sessions', { token: teacher, body: { courseId: course.id } });
  assert.equal(next.body.code, 'CN301-002');
  await t.close();
});

test('bad input is handled gracefully', async () => {
  const t = await boot();
  const stu = await t.login('23BCS001');
  assert.equal((await t.call('POST', '/api/attendance/attempts', { token: stu, body: {} })).status, 400);
  assert.equal((await t.call('POST', '/api/attendance/attempts', { token: stu, body: { courseId: 9999 } })).status, 404);
  assert.equal((await t.call('POST', '/api/attendance/attempts/nope/ble', { token: stu, body: {} })).status, 404);
  assert.equal((await t.call('DELETE', '/api/auth/login')).status, 405);
  await t.close();
});
