import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * The live link to the FreeTabs extension.
 *
 * FreeTabs (its background worker) connects to ws://127.0.0.1:47811. Several AI
 * apps can run this server at once (Claude Desktop and a few Claude Code
 * sessions, say): the first one to start listens on the port and becomes the
 * hub, the others connect to it as peers and their requests are relayed. When
 * the hub exits, a peer takes over and FreeTabs reconnects to it.
 *
 * Only the FreeTabs extension (a chrome-extension:// origin) and local peers
 * (no origin) are accepted, so web pages can't use the port.
 */
export const PORT = Number(process.env.FREETABS_PORT) || 47811;
const PING_MS = 20_000;
const REQUEST_MS = 20_000;

export function createLink({ port = PORT, client = 'An AI app' } = {}) {
  let label = client;
  let closed = false;
  let role = null; // 'hub' | 'peer'
  let wss = null;
  let extension = null; // hub: the extension's socket, once it said hello
  const peers = new Map(); // hub: socket -> label
  const relayed = new Map(); // hub: forwarded id -> { socket, id }
  let upstream = null; // peer: socket to the hub
  let hubHasExtension = false; // peer: what the hub last reported
  const pending = new Map(); // id -> { resolve, reject, timer }
  const waiters = new Set();
  let pingTimer = null;

  const connected = () => (role === 'hub' ? !!extension : role === 'peer' && hubHasExtension);
  const wake = () => {
    if (!connected()) return;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  };
  const send = (socket, message) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
  const clients = () => [...new Set([label, ...peers.values()])];

  function settle(id, message) {
    const waiting = pending.get(id);
    if (!waiting) return false;
    pending.delete(id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error));
    else waiting.resolve(message.result);
    return true;
  }

  function failPending(reason) {
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      pending.delete(id);
    }
  }

  // ---------- hub ----------

  function broadcastStatus() {
    for (const socket of peers.keys()) send(socket, { type: 'status', extension: !!extension });
    if (extension) send(extension, { type: 'clients', clients: clients() });
  }

  function onConnection(socket, req) {
    const origin = req.headers.origin;
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return socket.close(1008, 'wrong host');
    if (origin && !origin.startsWith('chrome-extension://')) return socket.close(1008, 'not allowed');

    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (origin) onExtensionMessage(socket, message);
      else onPeerMessage(socket, message);
    });
    socket.on('close', () => {
      if (socket === extension) {
        extension = null;
        failPending('FreeTabs disconnected before it answered.');
        for (const [id, route] of relayed) {
          send(route.socket, { type: 'res', id: route.id, error: 'FreeTabs disconnected before it answered.' });
          relayed.delete(id);
        }
        broadcastStatus();
      } else if (peers.delete(socket)) {
        broadcastStatus();
      }
    });
  }

  function onExtensionMessage(socket, message) {
    if (message.type === 'hello' && message.app === 'freetabs') {
      // One FreeTabs at a time (a second Chrome profile waits its turn).
      if (extension && extension !== socket && extension.readyState === WebSocket.OPEN) return socket.close(4000, 'busy');
      extension = socket;
      send(socket, { type: 'welcome', clients: clients() });
      broadcastStatus();
      wake();
      return;
    }
    if (socket !== extension || message.type !== 'res') return;
    if (settle(message.id, message)) return;
    const route = relayed.get(message.id);
    if (route) {
      relayed.delete(message.id);
      send(route.socket, { ...message, id: route.id });
    }
  }

  function onPeerMessage(socket, message) {
    if (message.type === 'peer-hello') {
      peers.set(socket, String(message.client || 'An AI app'));
      send(socket, { type: 'status', extension: !!extension });
      broadcastStatus();
      return;
    }
    if (!peers.has(socket)) return;
    if (message.type === 'peer-client') {
      peers.set(socket, String(message.client || 'An AI app'));
      broadcastStatus();
      return;
    }
    if (message.type === 'req') {
      if (!extension) return send(socket, { type: 'res', id: message.id, error: 'FreeTabs isn’t connected.' });
      const id = randomUUID();
      relayed.set(id, { socket, id: message.id });
      send(extension, { ...message, id, client: message.client || peers.get(socket) });
    }
  }

  // ---------- peer ----------

  function becomePeer() {
    role = 'peer';
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    upstream = socket;
    socket.on('open', () => send(socket, { type: 'peer-hello', client: label }));
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === 'status') {
        hubHasExtension = !!message.extension;
        wake();
      } else if (message.type === 'res') settle(message.id, message);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (upstream !== socket) return;
      upstream = null;
      hubHasExtension = false;
      failPending('The FreeTabs link restarted before FreeTabs answered.');
      // The hub went away: try to take its place (or follow whoever did).
      if (!closed) setTimeout(start, 150 + Math.random() * 350);
    });
  }

  // ---------- both ----------

  function start() {
    if (closed) return;
    role = null;
    const server = new WebSocketServer({ host: '127.0.0.1', port });
    server.on('listening', () => {
      wss = server;
      role = 'hub';
      server.on('connection', onConnection);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send(extension, { type: 'ping' }), PING_MS);
      pingTimer.unref?.();
    });
    server.on('error', (error) => {
      server.close();
      if (error.code === 'EADDRINUSE') becomePeer();
    });
  }

  /** Resolves true once FreeTabs is reachable, false after `ms`. */
  function waitForExtension(ms) {
    if (connected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), ms);
      waiters.add(done);
    });
  }

  function request(method, params = {}) {
    const target = role === 'hub' ? extension : upstream;
    if (!connected() || !target) return Promise.reject(new Error('FreeTabs isn’t connected.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('FreeTabs didn’t answer in time.'));
      }, REQUEST_MS);
      pending.set(id, { resolve, reject, timer });
      send(target, { type: 'req', id, client: label, method, params });
    });
  }

  /** The AI app's name, shown in FreeTabs ("Claude moved 3 tabs…"). */
  function setClient(name) {
    label = name;
    if (role === 'peer') send(upstream, { type: 'peer-client', client: label });
    else broadcastStatus();
  }

  function close() {
    closed = true;
    clearInterval(pingTimer);
    failPending('The FreeTabs link closed.');
    upstream?.close();
    for (const socket of wss?.clients ?? []) socket.terminate();
    wss?.close();
  }

  return {
    start,
    close,
    request,
    setClient,
    waitForExtension,
    get role() {
      return role;
    },
    get connected() {
      return connected();
    },
  };
}
