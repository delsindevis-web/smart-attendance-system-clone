import { HttpError } from '../errors.js';
import { audit } from '../db.js';
import { createFailureLimiter, signToken, verifyPassword } from '../auth.js';

export function registerAuthRoutes(r, app) {
  const { db, config } = app;
  const limiter = createFailureLimiter(10, 60_000);

  // POST /api/auth/login   { studentId | loginId, password? }
  r.post('/api/auth/login', ({ body, req }) => {
    const loginId = String(body.loginId ?? body.studentId ?? '').trim();
    if (!loginId) throw new HttpError(400, 'VALIDATION_ERROR', 'Please enter your student ID.');
    const key = `${req.socket.remoteAddress}|${loginId.toLowerCase()}`;
    limiter.check(key);

    const user = db.prepare('SELECT * FROM users WHERE login_id = ? COLLATE NOCASE').get(loginId);
    const passwordNeeded = config.requirePassword || user?.role !== 'student';
    const fail = () => {
      limiter.fail(key);
      audit(db, user?.id, 'login_failed', { loginId });
      return new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid ID or password.');
    };

    if (!user) throw fail();
    if (passwordNeeded && !verifyPassword(String(body.password ?? ''), user.password_hash)) throw fail();

    limiter.reset(key);
    audit(db, user.id, 'login');
    return {
      token: signToken(config, { sub: user.id, role: user.role }),
      user: { id: user.id, loginId: user.login_id, name: user.name, role: user.role },
    };
  });

  // GET /api/auth/me
  r.get('/api/auth/me', ({ user }) => ({
    user: { id: user.id, loginId: user.login_id, name: user.name, role: user.role },
  }), { roles: ['student', 'teacher'] });
}
