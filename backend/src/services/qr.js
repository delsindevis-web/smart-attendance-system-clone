import crypto from 'node:crypto';
import { HttpError } from '../errors.js';

/**
 * Teacher side: return the current rotating QR payload for a session,
 * minting a fresh token when the current one is (almost) expired.
 * The payload shape matches the original Member-3 QR page exactly.
 */
export function currentQr(app, session) {
  const { db, config } = app;
  const now = Date.now();
  let row = db.prepare(
    'SELECT * FROM qr_tokens WHERE session_id = ? ORDER BY issued_at DESC LIMIT 1'
  ).get(session.id);

  const ttl = config.qrTtlSeconds * 1000;
  const margin = Math.min(500, ttl / 10); // mint early so students never get a token about to die
  if (!row || row.expires_at - now < margin) {
    row = { token: crypto.randomUUID(), session_id: session.id, issued_at: now, expires_at: now + ttl };
    db.prepare('INSERT INTO qr_tokens (token, session_id, issued_at, expires_at) VALUES (?,?,?,?)')
      .run(row.token, row.session_id, row.issued_at, row.expires_at);
    // housekeeping: drop tokens that can no longer be valid
    db.prepare('DELETE FROM qr_tokens WHERE session_id = ? AND expires_at < ?')
      .run(session.id, now - 60_000);
  }
  return {
    sessionId: session.code,
    token: row.token,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Student side: validate a scanned token for this session. */
export function checkQrToken(app, session, token) {
  const { db, config } = app;
  if (typeof token !== 'string' || !token) {
    throw new HttpError(400, 'VALIDATION_ERROR', '`token` (from the scanned QR) is required.');
  }
  const row = db.prepare('SELECT * FROM qr_tokens WHERE token = ? AND session_id = ?').get(token, session.id);
  if (!row) throw new HttpError(422, 'QR_INVALID', 'This QR code does not belong to this class session.');
  const lateBy = Date.now() - row.expires_at;
  if (lateBy > config.qrGraceSeconds * 1000) {
    throw new HttpError(422, 'QR_EXPIRED', 'QR code has expired. Please scan the latest QR.');
  }
}
