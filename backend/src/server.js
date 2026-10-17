import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { HttpError } from './errors.js';
import { authenticate } from './auth.js';
import { createRouter } from './router.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerStudentRoutes } from './routes/student.js';
import { registerAttendanceRoutes } from './routes/attendance.js';
import { registerTeacherRoutes } from './routes/teacher.js';
import { seed } from './seed.js';

const MAX_BODY = 1_000_000; // 1 MB

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (['GET', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)) return resolve({});
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = overrides.db ?? openDb(config.dbPath);
  const app = { config, db };

  if (config.seedOnEmpty && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    seed(app);
    if (!config.quiet) console.log('Empty database: created demo data (see README for logins).');
  }

  const router = createRouter();
  registerAuthRoutes(router, app);
  registerStudentRoutes(router, app);
  registerAttendanceRoutes(router, app);
  registerTeacherRoutes(router, app);
  router.get('/api/health', () => ({ status: 'ok', time: new Date().toISOString() }));

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body, extra = {}) => {
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extra,
      };
      if (origin && config.corsOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      }
      res.writeHead(status, headers);
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') {
        return send(204, undefined, {
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '600',
        });
      }
      const found = router.match(req.method, url.pathname);
      if (!found) throw new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${url.pathname}`);

      const { route, params } = found;
      const user = route.roles ? authenticate(app, req) : null;
      if (user && !route.roles.includes(user.role)) {
        throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource.');
      }
      const body = await readJson(req);
      const out = await route.handler({
        app, req, params, body, user,
        query: Object.fromEntries(url.searchParams),
      });
      if (out && typeof out === 'object' && 'status' in out && 'body' in out) return send(out.status, out.body);
      return send(200, out ?? {});
    } catch (err) {
      if (err instanceof HttpError) {
        return send(err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      }
      console.error('Unhandled error:', err);
      return send(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' } });
    }
  });

  return { app, server };
}

// Run directly: `node src/server.js`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, server } = createApp();
  server.listen(app.config.port, () => {
    console.log(`Smart Attendance API listening on http://localhost:${app.config.port}`);
    console.log(`Required verification factors: ${app.config.requiredFactors.join(' + ')}`);
    if (!app.config.requirePassword) console.log('WARNING: REQUIRE_PASSWORD=false - students log in with ID only (development mode).');
  });
  const shutdown = () => { server.close(() => { app.db.close(); process.exit(0); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
