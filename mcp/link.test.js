import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createLink } from './link.js';
import { clientLabel, describe } from './write.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 48200 + Math.floor(Math.random() * 500);

/** Stands in for the extension's worker: says hello, answers requests. */
function fakeExtension(port, { origin = 'chrome-extension://freetabs-test' } = {}) {
  const seen = { requests: [], clients: [] };
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', app: 'freetabs', protocol: 1 })));
  socket.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.type === 'welcome' || m.type === 'clients') seen.clients = m.clients;
    if (m.type === 'req') {
      seen.requests.push(m);
      socket.send(JSON.stringify({ type: 'res', id: m.id, result: { method: m.method, client: m.client, params: m.params } }));
    }
  });
  socket.on('error', () => undefined);
  const closed = new Promise((r) => socket.on('close', (code) => r(code)));
  return { socket, seen, closed };
}

test('the extension connects and answers; web pages are refused', async () => {
  const port = nextPort++;
  const hub = createLink({ port, client: 'Claude' });
  hub.start();
  await sleep(100);
  assert.equal(hub.role, 'hub');
  assert.equal(await hub.waitForExtension(50), false);

  const page = fakeExtension(port, { origin: 'https://evil.example' });
  assert.equal(await page.closed, 1008, 'a web page origin is closed with policy violation');

  const ext = fakeExtension(port);
  assert.equal(await hub.waitForExtension(2000), true);
  assert.deepEqual(await hub.request('snapshot'), { method: 'snapshot', client: 'Claude', params: {} });
  assert.deepEqual(ext.seen.clients, ['Claude']);
  hub.close();
});

test('a second AI app relays through the first, and its name reaches FreeTabs', async () => {
  const port = nextPort++;
  const hub = createLink({ port, client: 'Claude' });
  hub.start();
  await sleep(100);
  const peer = createLink({ port, client: 'An AI app' });
  peer.start();
  await sleep(150);
  assert.equal(peer.role, 'peer');

  const ext = fakeExtension(port);
  assert.equal(await peer.waitForExtension(2000), true, 'the peer hears that FreeTabs connected');
  peer.setClient('Claude Code');
  await sleep(100);
  assert.deepEqual(ext.seen.clients.sort(), ['Claude', 'Claude Code']);
  const result = await peer.request('moveTabs', { ids: ['abc12345'], folder: 'Top' });
  assert.deepEqual(result, { method: 'moveTabs', client: 'Claude Code', params: { ids: ['abc12345'], folder: 'Top' } });
  hub.close();
  peer.close();
});

test('when the first app quits, the next one takes over the port', async () => {
  const port = nextPort++;
  const hub = createLink({ port, client: 'Claude' });
  hub.start();
  await sleep(100);
  const peer = createLink({ port, client: 'Claude Code' });
  peer.start();
  await sleep(150);
  hub.close();
  await sleep(900);
  assert.equal(peer.role, 'hub');
  fakeExtension(port);
  assert.equal(await peer.waitForExtension(2000), true);
  assert.equal((await peer.request('snapshot')).client, 'Claude Code');
  peer.close();
});

test('requests fail clearly when FreeTabs is not connected', async () => {
  const port = nextPort++;
  const hub = createLink({ port });
  hub.start();
  await sleep(100);
  await assert.rejects(hub.request('snapshot'), /isn’t connected/);
  hub.close();
});

test('what the model is told after a change', () => {
  assert.match(describe('copyTabs', { folder: 'Top prospects', created: true, copied: 3, skipped: 0, unknown: [] }), /Copied 3 tabs to “Top prospects” \(a new folder\)/);
  assert.match(describe('moveTabs', { folder: 'Later', created: false, moved: 1, unknown: ['zzzzzz'] }), /didn’t match a saved tab: zzzzzz/);
  assert.match(describe('createFolder', { folder: 'Inbox', created: false }), /already exists/);
  assert.equal(clientLabel('claude-code'), 'Claude Code');
  assert.equal(clientLabel('claude-ai'), 'Claude');
  assert.equal(clientLabel('something'), 'An AI app');
});
