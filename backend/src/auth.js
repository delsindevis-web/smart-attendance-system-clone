import crypto from 'node:crypto';
import { HttpError } from './errors.js';

// ---------- passwords (scrypt) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- tokens (HS256 JWT, no dependency) ----------
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(config, claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + Math.round(config.tokenTtlHours * 3600) };
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${body}.${hmac(config.jwtSecret, body)}`;
}

export function verifyToken(config, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(hmac(config.jwtSecret, body));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

/** Resolve the logged-in user from the Authorization header, or throw 401. */
export function authenticate(app, req) {
  const header = req.headers.authorization || '';
  const claims = verifyToken(app.config, header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!claims) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing or invalid token. Please log in again.');
  const user = app.db.prepare('SELECT id, login_id, name, role FROM users WHERE id = ?').get(claims.sub);
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists.');
  return user;
}

// ---------- tiny in-memory limiter for FAILED logins (brute-force protection) ----------
// Only failures count, and the key is IP + login ID, so a whole class logging in
// from the same campus Wi-Fi address is never throttled by each other's successes.
export function createFailureLimiter(max, windowMs) {
  const hits = new Map();
  const recent = (key) => (hits.get(key) || []).filter((t) => Date.now() - t < windowMs);
  return {
    check(key) {
      if (recent(key).length >= max) {
        throw new HttpError(429, 'RATE_LIMITED', 'Too many failed attempts. Please wait a minute and try again.');
      }
    },
    fail(key) { hits.set(key, [...recent(key), Date.now()]); },
    reset(key) { hits.delete(key); },
  };
}
