'use strict';
/**
 * Live updates with Server-Sent Events: tells every open browser of an app that
 * something changed, and who is online.
 */
const HEARTBEAT_MS = 25000;

class LiveHub {
  constructor() {
    this.clients = new Set(); // {appId, res, username, name}
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  /** Registers an open event stream. Returns a function that unregisters it. */
  connect(appId, res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { appId, res, username: user.username, name: user.name };
    this.clients.add(client);
    this.broadcastPresence(appId);
    return () => {
      if (!this.clients.delete(client)) return;
      this.broadcastPresence(appId);
    };
  }

  send(client, event, data) {
    try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ }
  }

  /** Unique users currently connected to an app. */
  presence(appId) {
    const seen = new Map();
    for (const c of this.clients) {
      if (c.appId === appId && !seen.has(c.username)) seen.set(c.username, { username: c.username, name: c.name });
    }
    return [...seen.values()];
  }

  onlineUsernames() {
    return new Set([...this.clients].map(c => c.username));
  }

  broadcast(appId, event, data) {
    for (const c of this.clients) if (c.appId === appId) this.send(c, event, data);
  }

  broadcastPresence(appId) {
    this.broadcast(appId, 'presence', this.presence(appId));
  }

  /** Closes all streams of a user (account disabled, role changed, deleted). */
  disconnectUser(username) {
    const apps = new Set();
    for (const c of [...this.clients]) {
      if (c.username !== username) continue;
      this.send(c, 'logout', {});
      try { c.res.end(); } catch (e) { /* closed */ }
      this.clients.delete(c);
      apps.add(c.appId);
    }
    for (const appId of apps) this.broadcastPresence(appId);
  }

  heartbeat() {
    for (const c of this.clients) { try { c.res.write(': ping\n\n'); } catch (e) { /* closed */ } }
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.clients) { try { c.res.end(); } catch (e) { /* closed */ } }
    this.clients.clear();
  }
}

module.exports = { LiveHub };
