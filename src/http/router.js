'use strict';
/**
 * Minimal router: router.get('/api/apps/:app/data', options, handler)
 *   options.auth: 'none' | 'user' (default) | 'admin' (portal admin)
 *   options.allowMustChange: true if a user who must still change their password may call it
 */
class Router {
  constructor() { this.routes = []; }

  add(method, pattern, options, handler) {
    if (typeof options === 'function') { handler = options; options = {}; }
    const names = [];
    const regex = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    this.routes.push({ method, regex, names, options: Object.assign({ auth: 'user', allowMustChange: false }, options), handler });
    return this;
  }

  get(p, o, h) { return this.add('GET', p, o, h); }
  post(p, o, h) { return this.add('POST', p, o, h); }
  put(p, o, h) { return this.add('PUT', p, o, h); }
  delete(p, o, h) { return this.add('DELETE', p, o, h); }

  /** @returns {{route, params}|{methodNotAllowed: true}|null} */
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.names.forEach((n, i) => {
        try { params[n] = decodeURIComponent(m[i + 1]); } catch (e) { params[n] = m[i + 1]; }
      });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router };
