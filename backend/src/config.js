import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORS = ['ble', 'qr', 'face'];

/** Minimal .env reader (no dependency). Real environment variables win. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function loadConfig(overrides = {}) {
  loadDotEnv(path.join(ROOT, '.env'));
  const env = process.env;
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : ['1', 'true', 'yes'].includes(env[k].toLowerCase()));
  const list = (k, d) => (env[k] ? env[k].split(',').map((s) => s.trim()).filter(Boolean) : d);

  const nodeEnv = env.NODE_ENV || 'development';
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (nodeEnv === 'production' && !overrides.jwtSecret) {
      throw new Error('JWT_SECRET must be set when NODE_ENV=production');
    }
    jwtSecret = 'dev-only-secret-change-me';
  }

  const config = {
    nodeEnv,
    port: num('PORT', 4000),
    jwtSecret,
    tokenTtlHours: num('TOKEN_TTL_HOURS', 12),
    dbPath: env.DB_PATH || path.join(ROOT, 'data', 'attendance.db'),
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    seedOnEmpty: bool('SEED_ON_EMPTY', true),
    requirePassword: bool('REQUIRE_PASSWORD', false),
    requiredFactors: list('REQUIRED_FACTORS', ['ble', 'face']),
    bleMinRssi: num('BLE_MIN_RSSI', -80),
    qrTtlSeconds: num('QR_TTL_SECONDS', 5),
    qrGraceSeconds: num('QR_GRACE_SECONDS', 3),
    livenessMinScore: num('LIVENESS_MIN_SCORE', 0.85),
    livenessChallengeTtlSeconds: num('LIVENESS_CHALLENGE_TTL_SECONDS', 30),
    livenessMinResponseMs: 800,
    attemptTtlMinutes: num('ATTEMPT_TTL_MINUTES', 10),
    quiet: false,
    ...overrides,
  };

  const bad = config.requiredFactors.filter((f) => !FACTORS.includes(f));
  if (bad.length || config.requiredFactors.length === 0) {
    throw new Error(`REQUIRED_FACTORS must be a non-empty subset of ${FACTORS.join(',')} (got: ${config.requiredFactors})`);
  }
  return config;
}
