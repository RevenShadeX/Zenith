'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cookie = require('cookie');
const signature = require('cookie-signature');
const WebSocket = require('ws');

const tempDirectory = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'zenith-runtime-'));
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.DATABASE_URL = '';
process.env.SQLITE_PATH = path.join(tempDirectory, 'runtime.db');
process.env.SESSION_SECRET = 'runtime-integration-test-secret-32-characters';

const runtime = require('../production-server');

function setSession(store, sessionId, discordUserId) {
  return new Promise((resolve, reject) => {
    store.set(sessionId, {
      cookie: { originalMaxAge: null, expires: null, secure: false, httpOnly: true, path: '/', sameSite: 'lax' },
      discordUserId,
    }, (error) => error ? reject(error) : resolve());
  });
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const receivedTypes = [];
    const timeout = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error(`Timed out waiting for ${predicate.toString()}; received: ${receivedTypes.join(', ') || 'none'}.`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      receivedTypes.push(message.type || 'unknown');
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeListener('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('default runtime enforces Discord identity and synchronizes host-controlled watch rooms', async (context) => {
  const { server } = await runtime.startServer();
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const hostId = '11111111111111111';
  const guestId = '22222222222222222';
  const strangerId = '33333333333333333';
  const secret = process.env.SESSION_SECRET;
  const store = runtime.getSessionStore();
  const sockets = [];

  context.after(async () => {
    for (const socket of sockets) socket.close();
    await runtime.shutdown();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  for (const [id, username] of [[hostId, 'host'], [guestId, 'guest'], [strangerId, 'stranger']]) {
    await runtime.database.run(
      'INSERT INTO users (discord_user_id, username, display_name, avatar, guild_id) VALUES (?, ?, ?, ?, ?)',
      [id, username, username, '', '44444444444444444']
    );
  }

  const sessions = new Map();
  for (const id of [hostId, guestId, strangerId]) {
    const sessionId = crypto.randomBytes(18).toString('hex');
    await setSession(store, sessionId, id);
    sessions.set(id, cookie.serialize('zenith.sid', `s:${signature.sign(sessionId, secret)}`));
  }

  async function request(url, options = {}, identity = null) {
    const headers = {
      Origin: base,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(identity ? { Cookie: sessions.get(identity) } : {}),
      ...(options.headers || {}),
    };
    return fetch(`${base}${url}`, { ...options, headers });
  }

  assert.equal((await request('/api/me')).status, 401);

  // Verify the same-origin static assets referenced by index.html are actually served.
  const pageResponse = await request('/');
  assert.equal(pageResponse.status, 200);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /href="\/css\/style\.css\?v=6"/);
  assert.match(pageHtml, /src="\/js\/media-providers\.js\?v=9"/);
  assert.match(pageHtml, /src="\/js\/app\.js\?v=10"/);

  const cssResponse = await request('/css/style.css?v=6');
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get('content-type') || '', /text\/css/i);
  assert.match(await cssResponse.text(), /:root\s*\{/);

  const mediaScriptResponse = await request('/js/media-providers.js?v=9');
  assert.equal(mediaScriptResponse.status, 200);
  assert.match(mediaScriptResponse.headers.get('content-type') || '', /javascript/i);
  assert.match(await mediaScriptResponse.text(), /class DirectVideoProvider/);

  const appScriptResponse = await request('/js/app.js?v=10');
  assert.equal(appScriptResponse.status, 200);
  assert.match(appScriptResponse.headers.get('content-type') || '', /javascript/i);
  assert.match(await appScriptResponse.text(), /function playbackPositionNow/);

  const login = await request('/auth/discord');
  assert.equal(login.status, 503);

  const createdResponse = await request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'Integration watch', mediaUrl: 'https://cdn.example/movie.mp4' }),
  }, hostId);
  assert.equal(createdResponse.status, 201);
  const { room } = await createdResponse.json();
  assert.equal(room.host_user_id, hostId);
  assert.equal(room.media_provider, 'direct_video');

  const guestEnd = await request(`/api/rooms/${room.id}/end`, { method: 'POST' }, guestId);
  assert.equal(guestEnd.status, 403);
  const guestLock = await request(`/api/rooms/${room.id}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ locked: true }),
  }, guestId);
  assert.equal(guestLock.status, 403);

  const hostLock = await request(`/api/rooms/${room.id}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ locked: true }),
  }, hostId);
  assert.equal(hostLock.status, 200);
  assert.equal((await request(`/api/rooms/${room.id}/join`, { method: 'POST' }, strangerId)).status, 403);
  assert.equal((await request(`/api/rooms/${room.id}/join`, { method: 'POST' }, hostId)).status, 200);

  await request(`/api/rooms/${room.id}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ locked: false }),
  }, hostId);
  assert.equal((await request(`/api/rooms/${room.id}/join`, { method: 'POST' }, guestId)).status, 200);
  assert.equal((await request(`/api/rooms/${room.id}/messages`, {}, guestId)).status, 200);
  assert.equal((await request(`/api/rooms/${room.id}/leave`, { method: 'POST' }, guestId)).status, 200);
  assert.equal((await request(`/api/rooms/${room.id}/messages`, {}, guestId)).status, 403);
  assert.equal((await request(`/api/rooms/${room.id}/join`, { method: 'POST' }, guestId)).status, 200);

  async function connect(identity, roomId = room.id) {
    const socket = new WebSocket(`${wsBase}/ws`, { headers: { Cookie: sessions.get(identity) }, origin: base });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const snapshot = waitForMessage(socket, (message) => message.type === 'room_snapshot');
    socket.send(JSON.stringify({ type: 'join_room', roomId }));
    return { socket, snapshot: await snapshot };
  }

  const hostConnection = await connect(hostId);
  const hostPresence = waitForMessage(hostConnection.socket, (message) => message.type === 'presence' && message.viewerCount === 2);
  const guestConnection = await connect(guestId);
  await hostPresence;
  assert.equal(hostConnection.snapshot.room.host_user_id, hostId);
  assert.equal(guestConnection.snapshot.viewerCount, 2);

  const syncedPlayback = waitForMessage(guestConnection.socket, (message) => message.type === 'playback_sync');
  hostConnection.socket.send(JSON.stringify({ type: 'playback', action: 'play', position: 24.5 }));
  const playback = await syncedPlayback;
  assert.equal(playback.state, 'playing');
  assert.equal(playback.position, 24.5);

  const pausedPlayback = waitForMessage(guestConnection.socket, (message) => message.type === 'playback_sync' && message.action === 'pause');
  hostConnection.socket.send(JSON.stringify({ type: 'playback', action: 'pause', position: 24.5 }));
  assert.equal((await pausedPlayback).state, 'paused');

  const soughtPlayback = waitForMessage(guestConnection.socket, (message) => message.type === 'playback_sync' && message.action === 'seek');
  hostConnection.socket.send(JSON.stringify({ type: 'playback', action: 'seek', position: 38.25 }));
  assert.equal((await soughtPlayback).position, 38.25);

  const deniedPlayback = waitForMessage(guestConnection.socket, (message) => message.type === 'error');
  guestConnection.socket.send(JSON.stringify({ type: 'playback', action: 'pause', position: 0 }));
  assert.match((await deniedPlayback).error, /host/i);

  const syncedMedia = waitForMessage(guestConnection.socket, (message) => message.type === 'media_changed');
  hostConnection.socket.send(JSON.stringify({ type: 'media_change', mediaUrl: 'https://youtu.be/abcdefghijk' }));
  assert.equal((await syncedMedia).room.media_provider, 'youtube');
  assert.equal((await runtime.database.get('SELECT media_url FROM rooms WHERE id = ?', [room.id])).media_url, 'https://youtu.be/abcdefghijk');

  const syncedChat = waitForMessage(guestConnection.socket, (message) => message.type === 'chat_message');
  hostConnection.socket.send(JSON.stringify({ type: 'chat_message', roomId: room.id, text: 'Hello from the host.' }));
  assert.equal((await syncedChat).message.content, 'Hello from the host.');

  guestConnection.socket.close();
  await new Promise((resolve) => guestConnection.socket.once('close', resolve));
  assert.equal((await request(`/api/rooms/${room.id}/join`, { method: 'POST' }, guestId)).status, 200);
  const reconnectedGuest = await connect(guestId);
  assert.equal(reconnectedGuest.snapshot.viewerCount, 2);
  sockets.push(reconnectedGuest.socket);

  const ended = waitForMessage(reconnectedGuest.socket, (message) => message.type === 'room_ended');
  hostConnection.socket.send(JSON.stringify({ type: 'playback', action: 'ended', position: 90 }));
  const mediaEnded = await ended;
  assert.equal(mediaEnded.roomId, room.id);
  assert.equal(mediaEnded.reason, 'media_ended');
  const endedRoom = await runtime.database.get('SELECT status, end_reason, ended_at FROM rooms WHERE id = ?', [room.id]);
  assert.equal(endedRoom.status, 'ended');
  assert.equal(endedRoom.end_reason, 'media_ended');
  assert.ok(endedRoom.ended_at);
  assert.equal((await request(`/api/rooms/${room.id}`, {}, guestId)).status, 200);
  assert.equal((await request(`/api/rooms/${room.id}/join`, { method: 'POST' }, strangerId)).status, 404);
  assert.equal((await request('/api/rooms')).status, 200);
  assert.equal((await (await request('/api/rooms')).json()).rooms.length, 0);

  const endedChat = waitForMessage(hostConnection.socket, (message) => message.type === 'room_ended' && message.reason === 'ended');
  hostConnection.socket.send(JSON.stringify({ type: 'chat_message', roomId: room.id, text: 'This should not be stored.' }));
  await endedChat;
  assert.equal(Number((await runtime.database.get('SELECT COUNT(*) AS count FROM room_messages WHERE room_id = ?', [room.id])).count), 1);

  const hostEndRoom = await request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'Host-ended room', mediaUrl: 'https://cdn.example/second.mp4' }),
  }, hostId);
  const { room: secondRoom } = await hostEndRoom.json();
  await request(`/api/rooms/${secondRoom.id}/join`, { method: 'POST' }, guestId);
  const secondHost = await connect(hostId, secondRoom.id);
  const secondGuest = await connect(guestId, secondRoom.id);
  const hostEnded = waitForMessage(secondGuest.socket, (message) => message.type === 'room_ended');
  const endResponse = await request(`/api/rooms/${secondRoom.id}/end`, { method: 'POST' }, hostId);
  const endBody = await endResponse.json();
  assert.equal(endResponse.status, 200);
  assert.equal(endBody.reason, 'host_ended');
  assert.equal((await hostEnded).roomId, secondRoom.id);
  assert.equal((await runtime.database.get('SELECT status, end_reason FROM rooms WHERE id = ?', [secondRoom.id])).end_reason, 'host_ended');
});