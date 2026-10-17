import crypto from 'node:crypto';
import { HttpError } from '../errors.js';

const ACTIONS = ['blink', 'turn_left', 'turn_right', 'smile', 'nod'];

/** Issue a one-time, randomised challenge so a pre-recorded result can't be replayed. */
export function issueChallenge(app, attempt) {
  const { db, config } = app;
  const shuffled = [...ACTIONS].sort(() => crypto.randomInt(3) - 1);
  const actions = shuffled.slice(0, 2);
  const challenge = {
    id: crypto.randomUUID(),
    nonce: crypto.randomBytes(16).toString('hex'),
    issued_at: Date.now(),
    expires_at: Date.now() + config.livenessChallengeTtlSeconds * 1000,
  };
  db.prepare(
    'INSERT INTO liveness_challenges (id, attempt_id, nonce, actions, issued_at, expires_at) VALUES (?,?,?,?,?,?)'
  ).run(challenge.id, attempt.id, challenge.nonce, JSON.stringify(actions), challenge.issued_at, challenge.expires_at);
  return {
    challengeId: challenge.id,
    nonce: challenge.nonce,
    actions,
    expiresAt: new Date(challenge.expires_at).toISOString(),
  };
}

/**
 * ============================  INTEGRATION POINT  ============================
 * Decide whether the liveness check passed.
 *
 * Right now the face-liveness module runs in the browser and reports
 * { passed, score }. The backend binds that report to a server-issued,
 * single-use, time-limited challenge, but it can NOT independently confirm the
 * client told the truth. When the real liveness model exists, replace the body
 * of this function (e.g. send captured frames to a Python/ONNX service and
 * return its score). Nothing else in the backend needs to change.
 * ============================================================================
 */
export async function evaluateLiveness(app, { challenge, payload }) {
  const score = Number(payload.score);
  if (payload.passed !== true || !Number.isFinite(score)) return { ok: false, score: Number.isFinite(score) ? score : 0 };
  return { ok: score >= app.config.livenessMinScore, score };
}

export async function verifyLiveness(app, attempt, payload) {
  const { db, config } = app;
  const { challengeId, nonce } = payload;
  if (typeof challengeId !== 'string' || typeof nonce !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '`challengeId` and `nonce` are required.');
  }
  const challenge = db.prepare('SELECT * FROM liveness_challenges WHERE id = ? AND attempt_id = ?').get(challengeId, attempt.id);
  if (!challenge || challenge.nonce !== nonce) {
    throw new HttpError(422, 'LIVENESS_CHALLENGE_INVALID', 'Unknown liveness challenge. Request a new one.');
  }
  // single use: burn it before evaluating, so a failed check can't be retried on the same challenge
  const burned = db.prepare('UPDATE liveness_challenges SET used = 1 WHERE id = ? AND used = 0').run(challengeId);
  if (burned.changes === 0) {
    throw new HttpError(422, 'LIVENESS_CHALLENGE_USED', 'This liveness challenge was already used. Request a new one.');
  }
  const now = Date.now();
  if (now > challenge.expires_at) {
    throw new HttpError(422, 'LIVENESS_CHALLENGE_EXPIRED', 'Liveness challenge expired. Request a new one.');
  }
  if (now - challenge.issued_at < config.livenessMinResponseMs) {
    throw new HttpError(422, 'LIVENESS_TOO_FAST', 'Response was too fast to be a real liveness check.');
  }
  const result = await evaluateLiveness(app, { challenge, payload });
  if (!result.ok) {
    throw new HttpError(422, 'LIVENESS_FAILED', 'Face liveness could not be verified. Please try again.', {
      minScore: config.livenessMinScore,
    });
  }
  return { score: result.score };
}
