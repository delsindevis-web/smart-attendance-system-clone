import { HttpError } from './errors.js';

/**
 * Minimal router: r.get('/api/x/:id', handler, { roles: ['student'] })
 * `roles` omitted => public. Handler receives ctx and returns a JSON-able value
 * (or { status, body }).
 */
export function createRouter() {
  const routes = [];
  const add = (method) => (path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, roles: opts.roles });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return null;
    },
  };
}
