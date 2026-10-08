'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');
const dotenv = require('dotenv');
const { createDatabase } = require('./database');
const { createDiscordBot } = require('./discord-bot');
const { getDiscordLeaderboard, recordGuildMessage } = require('./discord-activity');
const { canJoinRoom, isRoomHost } = require('./room-policy');
const { classifyMediaUrl } = require('./media');
const { leaderboardWindowStart } = require('./leaderboard');
const { getMissionState, claimMission } = require('./missions');
const { checkAndUnlockBadges, getBadgesForUsers, getUserBadges } = require('./badges');
const { getStudyLeaderboard, getStudyVcChannelId, setStudyVcChannelId, startStudySession, stopStudySession, flushStudySessions } = require('./study-vc');
const { assertProductionConfig } = require('./production-config');
const { getSeasonKey, ensureUserSeason, ensureUsersCurrentSeason } = require('./season');

dotenv.config();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_INSECURE_HTTP = String(process.env.ALLOW_INSECURE_HTTP || '').toLowerCase() === 'true';
const USE_SECURE_COOKIES = IS_PRODUCTION && !ALLOW_INSECURE_HTTP;
assertProductionConfig(process.env);

const PORT = Number(process.env.PORT || 3000);
const OAUTH_CONFIGURED = Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI && process.env.DISCORD_GUILD_ID);
const BOT_CONFIGURED = Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);
const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE_NAME = USE_SECURE_COOKIES ? '__Host-zenith.sid' : 'zenith.sid';
const DATABASE_URL = process.env.DATABASE_URL || '';
const database = createDatabase({ databaseUrl: DATABASE_URL });
const roomSockets = new Map();
const activeConnections = new Set();
const connectionCleanups = new Set();
const app = express();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
let discordBot = null;
let server = null;
let studyFlushTimer = null;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sessionCallback(req, method) {
  return new Promise((resolve, reject) => {
    req.session[method]((error) => error ? reject(error) : resolve());
  });
}

function isSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return !IS_PRODUCTION;
  try {
    const appOrigin = process.env.DISCORD_REDIRECT_URI
      ? new URL(process.env.DISCORD_REDIRECT_URI).origin
      : `${req.protocol}://${req.get('host')}`;
    return new URL(origin).origin === appOrigin;
  } catch {
    return false;
  }
}

function requireSameOrigin(req, res, next) {
  if (!isSameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request rejected.' });
  next();
}

function requireAuth(req, res, next) {
  if (!req.session?.discordUserId) return res.status(401).json({ error: 'Discord authentication required.' });
  next();
}

function sanitizeText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function toPublicUser(row, admin = false, badges = []) {
  if (!row) return null;
  return {
    id: row.discord_user_id,
    discordUserId: row.discord_user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatar: row.avatar || '',
    guildId: row.guild_id,
    trackedMessageCount: Number(row.season_message_count || 0),
    lifetimeMessageCount: Number(row.tracked_message_count || 0),
    lastMessageAt: row.last_message_at || null,
    xp: Number(row.season_xp || 0),
    points: Number(row.season_points || 0),
    level: Math.floor(Math.sqrt(Number(row.season_xp || 0) / 100)) + 1,
    lifetimeXp: Number(row.xp || 0),
    lifetimePoints: Number(row.points || 0),
    movieNights: Number(row.movie_nights || 0),
    musicNights: Number(row.music_nights || 0),
    gameWins: Number(row.game_wins || 0),
    currentStreak: Number(row.current_streak || 0),
    badges,
    seasonKey: row.season_key || getSeasonKey(),
    admin,
  };
}

function discordAvatar(profile) {
  if (profile.avatar) {
    const extension = profile.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${extension}`;
  }
  const discriminator = Number(profile.discriminator || 0);
  return `https://cdn.discordapp.com/embed/avatars/${discriminator % 6}.png`;
}

async function getUser(discordUserId) {
  return database.get('SELECT * FROM users WHERE discord_user_id = ?', [discordUserId]);
}

async function getPublicUser(discordUserId) {
  await ensureUserSeason(database, discordUserId);
  const user = await getUser(discordUserId);
  let admin = false;
  if (user && discordBot) {
    try {
      admin = await discordBot.isGuildAdministrator(discordUserId);
    } catch {
      admin = false;
    }
  }
  const badges = user ? await checkAndUnlockBadges(database, discordUserId) : [];
  return toPublicUser(user, admin, badges);
}

async function upsertDiscordUser(profile) {
  if (!/^\d{17,20}$/.test(String(profile.id || ''))) throw new Error('Discord returned an invalid user identity.');
  const username = sanitizeText(profile.username, 80) || 'discord-user';
  const displayName = sanitizeText(profile.global_name || profile.username, 100) || username;
  const avatar = discordAvatar(profile);
  await database.run(
    `INSERT INTO users (discord_user_id, username, display_name, avatar, guild_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar = excluded.avatar,
       guild_id = excluded.guild_id,
       updated_at = CURRENT_TIMESTAMP`,
    [String(profile.id), username, displayName, avatar, process.env.DISCORD_GUILD_ID]
  );
  return getUser(String(profile.id));
}

function trackingDateKey() {
  return 'discord_tracking_started_at';
}

async function recordDiscordMessage(message) {
  return recordGuildMessage(database, message, process.env.DISCORD_GUILD_ID);
}

async function getTrackingInfo() {
  const setting = await database.get('SELECT setting_value FROM app_settings WHERE setting_key = ?', [trackingDateKey()]);
  return {
    trackingStartedAt: setting?.setting_value || null,
    historicalMessageCount: null,
    historicalImported: false,
    messageScope: 'Messages tracked by the Zenith bot after its installation and first connection.',
    historicalScope: 'Historical Discord messages are not imported or included.',
  };
}

const DAILY_WORDS = [
  'APPLE', 'BEACH', 'BRAIN', 'BRAVE', 'CHAIR', 'CHESS', 'CLOUD', 'CRANE', 'DREAM', 'EARTH',
  'FLAME', 'FRAME', 'FRUIT', 'GIANT', 'GRAPE', 'GRASS', 'GREEN', 'HEART', 'HOUSE', 'IMAGE',
  'JUICE', 'KNIFE', 'LIGHT', 'MAGIC', 'MANGO', 'MONEY', 'MUSIC', 'NIGHT', 'OCEAN', 'PAINT',
  'PAPER', 'PARTY', 'PEACH', 'PEARL', 'PIANO', 'PIXEL', 'PLANT', 'PLATE', 'POINT', 'POWER',
  'QUEST', 'QUIET', 'RADIO', 'RIVER', 'ROBOT', 'ROUND', 'ROYAL', 'SCALE', 'SHINE', 'SHIRT',
  'SHOES', 'SHORT', 'SKATE', 'SMILE', 'SPACE', 'SPARK', 'SPEED', 'SPORT', 'STONE', 'STORM',
  'SUGAR', 'TABLE', 'TIGER', 'TOAST', 'TODAY', 'TRAIN', 'TRAIL', 'TRUST', 'UNCLE', 'UNION',
  'VALUE', 'VIDEO', 'VOICE', 'WATER', 'WHEEL', 'WORLD', 'WRITE', 'YOUTH', 'ZEBRA', 'ALARM',
  'ALBUM', 'ALERT', 'ANGEL', 'ANIME', 'BASIC', 'BLACK', 'BLOCK', 'BLOOM', 'BOARD', 'BOOST',
  'BOXER', 'BROWN', 'CANDY', 'CARRY', 'CATCH', 'CHILL', 'CLEAN', 'CLEAR', 'COAST', 'COLOR'
];

function zenithDateKey(date = new Date()) {
  const timeZone = process.env.ZENITH_TIMEZONE || 'Asia/Colombo';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

function shiftZenithDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return zenithDateKey(utc);
}

async function refreshDailyStreak(discordUserId, dateKey) {
  const solvedRows = await database.all(
    'SELECT date_key FROM daily_game_attempts WHERE discord_user_id = ? AND solved = ? ORDER BY date_key DESC',
    [discordUserId, true]
  );
  const solvedDates = new Set(solvedRows.map((row) => row.date_key));
  let streak = 0;
  let cursor = dateKey;
  while (solvedDates.has(cursor)) {
    streak += 1;
    cursor = shiftZenithDateKey(cursor, -1);
  }
  await database.run(
    'UPDATE users SET current_streak = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?',
    [streak, discordUserId]
  );
  return streak;
}

async function getDailyGameState(discordUserId, dateKey = zenithDateKey()) {
  let daily = await database.get('SELECT word FROM daily_words WHERE date_key = ?', [dateKey]);
  if (!daily) {
    let hash = 0;
    for (const character of dateKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    const word = DAILY_WORDS[hash % DAILY_WORDS.length];
    await database.run('INSERT OR IGNORE INTO daily_words (date_key, word) VALUES (?, ?)', [dateKey, word]);
    daily = await database.get('SELECT word FROM daily_words WHERE date_key = ?', [dateKey]);
  }
  const attempts = await database.get('SELECT guesses, solved, guesses_json FROM daily_game_attempts WHERE date_key = ? AND discord_user_id = ?', [dateKey, discordUserId]);
  let guesses = [];
  try { guesses = attempts ? JSON.parse(attempts.guesses_json || '[]') : []; } catch { guesses = []; }
  const currentStreak = await refreshDailyStreak(discordUserId, dateKey);
  return { date: dateKey, attempts: guesses, solved: Boolean(attempts?.solved), answer: attempts?.solved ? daily.word : null, attemptsRemaining: Math.max(0, 6 - guesses.length), currentStreak };
}

async function getMessageLeaderboard(period = 'all_time', now = new Date()) {
  await ensureUsersCurrentSeason(database, process.env.DISCORD_GUILD_ID || 'unconfigured', now);
  return getDiscordLeaderboard(database, process.env.DISCORD_GUILD_ID || 'unconfigured', period, now);
}

function connectedUsers(roomId) {
  const clients = roomSockets.get(roomId) || new Set();
  const unique = new Map();
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN && socket.user) unique.set(socket.user.id, socket.user);
  }
  return [...unique.values()];
}

function viewerCount(roomId) {
  return connectedUsers(roomId).length;
}

function publicRoom(room) {
  if (!room) return null;
  let mediaEmbedUrl = null;
  try {
    mediaEmbedUrl = classifyMediaUrl(room.media_url).embed_url;
  } catch {
    mediaEmbedUrl = null;
  }
  return {
    id: room.id,
    name: room.name,
    host_user_id: room.host_user_id,
    host_display_name: room.host_display_name || null,
    host_avatar: room.host_avatar || null,
    media_provider: room.media_provider,
    media_url: room.media_url,
    media_embed_url: mediaEmbedUrl,
    status: room.status,
    locked: Boolean(room.locked),
    playback_state: room.playback_state,
    playback_position: Number(room.playback_position || 0),
    playback_updated_at: room.playback_updated_at,
    ended_at: room.ended_at || null,
    end_reason: room.end_reason || null,
    created_at: room.created_at,
    viewer_count: viewerCount(room.id),
  };
}

function sendSocket(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcastRoom(roomId, payload) {
  const clients = roomSockets.get(roomId) || new Set();
  for (const socket of clients) sendSocket(socket, payload);
}

function broadcastPresence(roomId) {
  broadcastRoom(roomId, {
    type: 'presence',
    roomId,
    viewerCount: viewerCount(roomId),
    users: connectedUsers(roomId).map(({ id, username, displayName, avatar }) => ({ id, username, displayName, avatar })),
  });
}

async function playbackSnapshot(room) {
  const position = Number(room.playback_position || 0);
  const updatedAt = new Date(room.playback_updated_at || Date.now()).getTime();
  const currentPosition = room.playback_state === 'playing' && Number.isFinite(updatedAt)
    ? Math.max(0, position + (Date.now() - updatedAt) / 1000)
    : position;
  return {
    state: room.playback_state,
    position: currentPosition,
    serverTime: Date.now(),
  };
}

async function roomSnapshot(roomId) {
  const room = await database.get('SELECT r.*, u.display_name AS host_display_name, u.avatar AS host_avatar FROM rooms r LEFT JOIN users u ON u.discord_user_id = r.host_user_id WHERE r.id = ?', [roomId]);
  if (!room) return null;
  return {
    room: publicRoom(room),
    playback: await playbackSnapshot(room),
    viewerCount: viewerCount(roomId),
    users: connectedUsers(roomId).map(({ id, username, displayName, avatar }) => ({ id, username, displayName, avatar })),
  };
}

async function emitRoomSnapshot(roomId) {
  const snapshot = await roomSnapshot(roomId);
  if (snapshot) broadcastRoom(roomId, { type: 'room_state', roomId, ...snapshot });
}

async function removeSocketFromRoom(socket, removeMembership = true) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const clients = roomSockets.get(roomId);
  clients?.delete(socket);
  if (clients?.size === 0) roomSockets.delete(roomId);
  socket.roomId = null;
  const userStillConnected = [...(roomSockets.get(roomId) || [])].some((client) => client.userId === socket.userId && client.readyState === WebSocket.OPEN);
  if (removeMembership && socket.userId && !userStillConnected) {
    await database.run('DELETE FROM room_members WHERE room_id = ? AND discord_user_id = ?', [roomId, socket.userId]);
  }
  if (!userStillConnected) broadcastRoom(roomId, { type: 'user_left', roomId, userId: socket.userId });
  broadcastPresence(roomId);
}

function hostOnly(socket, room) {
  return room?.status === 'live' && isRoomHost(room, socket.userId);
}

async function handleRoomSocketMessage(socket, raw) {
  let data;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return sendSocket(socket, { type: 'error', error: 'Invalid message payload.' });
  }
  if (!data || typeof data.type !== 'string') return;

  if (data.type === 'join_room') {
    const roomId = String(data.roomId || '').slice(0, 80);
    const room = await database.get('SELECT * FROM rooms WHERE id = ?', [roomId]);
    if (!room || room.status !== 'live') return sendSocket(socket, { type: 'error', error: 'Room is unavailable.' });
    const membership = await database.get('SELECT discord_user_id FROM room_members WHERE room_id = ? AND discord_user_id = ?', [roomId, socket.userId]);
    if (!canJoinRoom(room, socket.userId, Boolean(membership))) {
      return sendSocket(socket, { type: 'error', error: 'Join this room before connecting.' });
    }

    if (socket.roomId && socket.roomId !== roomId) await removeSocketFromRoom(socket);
    socket.roomId = roomId;
    const clients = roomSockets.get(roomId) || new Set();
    clients.add(socket);
    roomSockets.set(roomId, clients);
    const snapshot = await roomSnapshot(roomId);
    sendSocket(socket, { type: 'room_snapshot', roomId, ...snapshot });
    broadcastRoom(roomId, { type: 'user_joined', roomId, user: socket.user });
    broadcastPresence(roomId);
    return;
  }

  if (data.type === 'leave_room') {
    await removeSocketFromRoom(socket);
    return;
  }

  if (data.type === 'chat_message') {
    const roomId = socket.roomId;
    const now = Date.now();
    if (!roomId || data.roomId !== roomId) return;
    const room = await database.get('SELECT status FROM rooms WHERE id = ?', [roomId]);
    if (!room || room.status !== 'live') return sendSocket(socket, { type: 'room_ended', roomId, reason: 'ended' });
    if (now - (socket.lastChatAt || 0) < 700) return sendSocket(socket, { type: 'error', error: 'Please wait before sending another message.' });
    const text = sanitizeText(data.text, 240);
    if (!text) return;
    const messageResult = await database.run(
      'INSERT INTO room_messages (room_id, discord_user_id, username, avatar, content) VALUES (?, ?, ?, ?, ?)',
      [roomId, socket.userId, socket.user.username, socket.user.avatar, text]
    );
    const message = await database.get('SELECT * FROM room_messages WHERE id = ?', [messageResult.id]);
    socket.lastChatAt = now;
    broadcastRoom(roomId, { type: 'chat_message', roomId, message });
    return;
  }

  const roomId = socket.roomId;
  const room = roomId ? await database.get('SELECT * FROM rooms WHERE id = ?', [roomId]) : null;
  if (!hostOnly(socket, room)) return sendSocket(socket, { type: 'error', error: 'Only this room’s host can control it.' });

  if (data.type === 'playback') {
    const action = data.action;
    if (!['play', 'pause', 'seek', 'ended'].includes(action)) return sendSocket(socket, { type: 'error', error: 'Unsupported playback action.' });
    const position = Number(data.position);
    if (!Number.isFinite(position) || position < 0 || position > 86400) return sendSocket(socket, { type: 'error', error: 'Playback position is invalid.' });
    if (action === 'ended') {
      const endedAt = new Date().toISOString();
      await database.run("UPDATE rooms SET status = 'ended', playback_state = 'ended', playback_position = ?, playback_updated_at = ?, ended_at = ?, end_reason = 'media_ended', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [position, endedAt, endedAt, roomId]);
      broadcastRoom(roomId, { type: 'room_ended', roomId, endedAt, reason: 'media_ended' });
      return;
    }
    const playbackState = action === 'pause' ? 'paused' : action === 'play' ? 'playing' : room.playback_state;
    const updatedAt = new Date().toISOString();
    await database.run('UPDATE rooms SET playback_state = ?, playback_position = ?, playback_updated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playbackState, position, updatedAt, roomId]);
    broadcastRoom(roomId, { type: 'playback_sync', roomId, action, state: playbackState, position, serverTime: Date.now(), by: socket.userId });
    return;
  }

  if (data.type === 'media_change') {
    let media;
    try {
      media = classifyMediaUrl(data.mediaUrl);
    } catch (error) {
      return sendSocket(socket, { type: 'error', error: error.message });
    }
    await database.run('UPDATE rooms SET media_provider = ?, media_url = ?, playback_state = ?, playback_position = 0, playback_updated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [media.provider, media.source_url, 'paused', new Date().toISOString(), roomId]);
    const updatedRoom = await database.get('SELECT r.*, u.display_name AS host_display_name, u.avatar AS host_avatar FROM rooms r LEFT JOIN users u ON u.discord_user_id = r.host_user_id WHERE r.id = ?', [roomId]);
    broadcastRoom(roomId, { type: 'media_changed', roomId, room: publicRoom(updatedRoom), media });
    return;
  }

  if (data.type === 'room_lock') {
    const locked = Boolean(data.locked);
    await database.run('UPDATE rooms SET locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [locked, roomId]);
    broadcastRoom(roomId, { type: 'room_locked', roomId, locked });
    return;
  }

  if (data.type === 'room_end') {
    const endedAt = new Date().toISOString();
    await database.run("UPDATE rooms SET status = 'ended', playback_state = 'ended', ended_at = ?, end_reason = 'host_ended', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [endedAt, roomId]);
    broadcastRoom(roomId, { type: 'room_ended', roomId, endedAt, reason: 'host_ended' });
  }
}

async function exchangeDiscordCode(code) {
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Discord rejected the OAuth code.');
  const token = await response.json();
  if (!token.access_token) throw new Error('Discord did not return an access token.');
  return token.access_token;
}

async function fetchDiscordResource(pathname, accessToken) {
  const response = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Discord identity verification failed (${response.status}).`);
  return response.json();
}

function requireGuildAdmin(req, res, next) {
  if (!discordBot) return res.status(503).json({ error: 'Discord bot is not connected.' });
  discordBot.isGuildAdministrator(req.session.discordUserId)
    .then((isAdmin) => isAdmin ? next() : res.status(403).json({ error: 'Discord server administrator permission required.' }))
    .catch(() => res.status(403).json({ error: 'Discord server administrator permission required.' }));
}

async function requireRoomHost(req, res) {
  const room = await database.get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return null;
  }
  if (!isRoomHost(room, req.session.discordUserId)) {
    res.status(403).json({ error: 'Only the room host can perform this action.' });
    return null;
  }
  if (room.status !== 'live') {
    res.status(409).json({ error: 'This room has already ended.' });
    return null;
  }
  return room;
}

function createApp() {
  app.disable('x-powered-by');
  if (IS_PRODUCTION) app.set('trust proxy', 1);

  app.use(helmet({
    strictTransportSecurity: USE_SECURE_COOKIES ? undefined : false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", 'https://www.youtube.com', 'https://player.vimeo.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        upgradeInsecureRequests: USE_SECURE_COOKIES ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.use(sessionMiddleware);

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  const guessLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  app.get('/auth/discord', authLimiter, asyncRoute(async (req, res) => {
    if (!OAUTH_CONFIGURED) return res.status(503).send('Discord OAuth is not configured. Set the Discord OAuth environment variables to enable login.');
    const state = crypto.randomBytes(32).toString('base64url');
    req.session.oauthState = state;
    await sessionCallback(req, 'save');
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds.members.read',
      state,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  }));

  app.get('/auth/discord/callback', authLimiter, asyncRoute(async (req, res) => {
    if (!OAUTH_CONFIGURED) return res.status(503).send('Discord OAuth is not configured.');
    if (req.query.error) return res.status(400).send('Discord authorization was cancelled.');
    const suppliedState = String(req.query.state || '');
    const expectedState = String(req.session.oauthState || '');
    const suppliedStateBuffer = Buffer.from(suppliedState);
    const expectedStateBuffer = Buffer.from(expectedState);
    delete req.session.oauthState;
    if (!suppliedState || !expectedState || suppliedStateBuffer.length !== expectedStateBuffer.length || !crypto.timingSafeEqual(suppliedStateBuffer, expectedStateBuffer)) {
      return res.status(400).send('Invalid OAuth state. Please restart Discord login.');
    }
    const code = String(req.query.code || '');
    if (!code || code.length > 2048) return res.status(400).send('Missing or invalid Discord OAuth code.');

    let profile;
    try {
      const accessToken = await exchangeDiscordCode(code);
      [profile] = await Promise.all([
        fetchDiscordResource('/users/@me', accessToken),
        fetchDiscordResource(`/users/@me/guilds/${encodeURIComponent(process.env.DISCORD_GUILD_ID)}/member`, accessToken),
      ]);
    } catch (error) {
      console.error('Discord OAuth verification failed:', error.message);
      return res.status(403).send('Discord login could not verify your account and server membership.');
    }

    const user = await upsertDiscordUser(profile);
    await sessionCallback(req, 'regenerate');
    req.session.discordUserId = user.discord_user_id;
    await sessionCallback(req, 'save');
    res.redirect('/');
  }));

  app.post('/auth/logout', requireSameOrigin, (req, res) => {
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ error: 'Sign out failed.' });
      res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: USE_SECURE_COOKIES, sameSite: 'lax', path: '/' });
      res.json({ ok: true });
    });
  });

  app.get('/api/health', asyncRoute(async (req, res) => {
    await database.get('SELECT 1 AS ok');
    res.json({ ok: true, name: 'Zenith', uptime: process.uptime(), timestamp: new Date().toISOString() });
  }));

  app.get('/api/status', asyncRoute(async (req, res) => {
    const started = performance.now();
    const [userCount, roomCount] = await Promise.all([
      database.get('SELECT COUNT(*) AS count FROM users'),
      database.get("SELECT COUNT(*) AS count FROM rooms WHERE status = 'live'"),
    ]);
    const onlineUsers = [...roomSockets.values()].reduce((total, sockets) => total + new Set([...sockets].filter((socket) => socket.readyState === WebSocket.OPEN).map((socket) => socket.userId)).size, 0);
    res.json({
      website: 'Operational',
      api: 'Operational',
      websocket: 'Operational',
      database: 'Operational',
      discordAuth: OAUTH_CONFIGURED ? 'Configured' : 'Not configured',
      discordBot: discordBot ? 'Connected' : 'Not connected',
      onlineUsers,
      activeRooms: Number(roomCount?.count || 0),
      totalUsers: Number(userCount?.count || 0),
      uptime: `${(process.uptime() / 60).toFixed(1)} min`,
      apiLatency: `${Math.round(performance.now() - started)} ms`,
    });
  }));

  app.get('/api/me', asyncRoute(async (req, res) => {
    if (!req.session?.discordUserId) return res.status(401).json({ error: 'Discord authentication required.' });
    const user = await getPublicUser(req.session.discordUserId);
    if (!user) return res.status(401).json({ error: 'Discord account is no longer available.' });
    res.json({ user });
  }));

  app.get('/api/badges', requireAuth, asyncRoute(async (req, res) => {
    const badges = await checkAndUnlockBadges(database, req.session.discordUserId);
    res.json({ season: getSeasonKey(), badges });
  }));

  app.get('/api/seasons/history', requireAuth, asyncRoute(async (req, res) => {
    const history = await database.all(
      'SELECT season_key, xp, points, messages, level, study_seconds, badge_count, archived_at FROM season_history WHERE discord_user_id = ? ORDER BY season_key DESC LIMIT 24',
      [req.session.discordUserId]
    );
    res.json({ currentSeason: getSeasonKey(), history });
  }));

  app.get('/api/community/tracking', asyncRoute(async (req, res) => {
    res.json(await getTrackingInfo());
  }));
  app.get('/api/missions', requireAuth, asyncRoute(async (req, res) => {
    res.json(await getMissionState(database, req.session.discordUserId));
  }));

  app.post('/api/missions/:id/claim', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const periodKey = String(req.body?.periodKey || '');
    if (!periodKey) return res.status(400).json({ error: 'Mission period is required.' });
    try {
      const reward = await claimMission(database, req.session.discordUserId, String(req.params.id), periodKey);
      const user = await getPublicUser(req.session.discordUserId);
      res.json({ ok: true, reward, user, missions: await getMissionState(database, req.session.discordUserId) });
    } catch (error) {
      const status = /not found|expired/i.test(error.message) ? 404 : /already been claimed/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    }
  }));



  app.get('/api/community/leaderboard', asyncRoute(async (req, res) => {
    const period = String(req.query.period || 'all_time');
    const [users, studyLeaderboard, tracking] = await Promise.all([
      getMessageLeaderboard(period),
      getStudyLeaderboard(database, process.env.DISCORD_GUILD_ID || 'unconfigured'),
      getTrackingInfo(),
    ]);
    await Promise.all(users.slice(0, 20).map((user) => checkAndUnlockBadges(database, user.id || user.discord_user_id)));
    const badgeMap = await getBadgesForUsers(database, users.slice(0, 20).map((user) => user.id || user.discord_user_id));
    for (const user of users) user.badges = (badgeMap.get(String(user.id || user.discord_user_id)) || []).slice(-3).reverse();
    const studyChannelId = await getStudyVcChannelId(database);
    res.json({ period, users, studyLeaderboard, studyChannelId, tracking, source: 'discord_message_events' });
  }));

  app.get('/api/leaderboards', asyncRoute(async (req, res) => {
    const period = String(req.query.period || 'all_time');
    const users = await getMessageLeaderboard(period);
    res.json({ period, users, source: 'discord_message_events' });
  }));

  app.get('/api/home', asyncRoute(async (req, res) => {
    const viewerId = req.session?.discordUserId || '';
    const [rooms, events, leaderboard, status, tracking] = await Promise.all([
      database.all("SELECT r.*, u.display_name AS host_display_name, u.avatar AS host_avatar FROM rooms r LEFT JOIN users u ON u.discord_user_id = r.host_user_id WHERE r.status = 'live' AND (r.locked = FALSE OR r.host_user_id = ? OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.discord_user_id = ?)) ORDER BY r.created_at DESC LIMIT 8", [viewerId, viewerId]),
      database.all("SELECT * FROM events WHERE status = 'upcoming' AND end_time > ? ORDER BY start_time ASC LIMIT 8", [new Date().toISOString()]),
      getMessageLeaderboard('all_time'),
      fetchStatus(),
      getTrackingInfo(),
    ]);
    res.json({ rooms: rooms.map(publicRoom), events, leaderboard, latestMessages: [], status, tracking });
  }));

  async function fetchStatus() {
    const started = performance.now();
    const [userCount, roomCount] = await Promise.all([
      database.get('SELECT COUNT(*) AS count FROM users'),
      database.get("SELECT COUNT(*) AS count FROM rooms WHERE status = 'live'"),
    ]);
    return {
      website: 'Operational',
      api: 'Operational',
      websocket: 'Operational',
      database: 'Operational',
      discordAuth: OAUTH_CONFIGURED ? 'Configured' : 'Not configured',
      discordBot: discordBot ? 'Connected' : 'Not connected',
      onlineUsers: [...roomSockets.values()].reduce((total, sockets) => total + new Set([...sockets].map((socket) => socket.userId)).size, 0),
      activeRooms: Number(roomCount?.count || 0),
      totalUsers: Number(userCount?.count || 0),
      uptime: `${(process.uptime() / 60).toFixed(1)} min`,
      apiLatency: `${Math.round(performance.now() - started)} ms`,
    };
  }

  app.get('/api/rooms', asyncRoute(async (req, res) => {
    const viewerId = req.session?.discordUserId || '';
    const rooms = await database.all("SELECT r.*, u.display_name AS host_display_name, u.avatar AS host_avatar FROM rooms r LEFT JOIN users u ON u.discord_user_id = r.host_user_id WHERE r.status = 'live' AND (r.locked = FALSE OR r.host_user_id = ? OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.discord_user_id = ?)) ORDER BY r.created_at DESC", [viewerId, viewerId]);
    res.json({ rooms: rooms.map(publicRoom) });
  }));

  app.get('/api/rooms/:id', asyncRoute(async (req, res) => {
    const snapshot = await roomSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'Room not found.' });
    if (snapshot.room.status === 'ended') {
      const roomAccess = await database.get('SELECT discord_user_id FROM room_members WHERE room_id = ? AND discord_user_id = ?', [req.params.id, req.session?.discordUserId || '']);
      if (!roomAccess && snapshot.room.host_user_id !== req.session?.discordUserId) return res.status(404).json({ error: 'Room not found.' });
      return res.json(snapshot);
    }
    if (snapshot.room.locked && snapshot.room.host_user_id !== req.session?.discordUserId) {
      const membership = await database.get('SELECT discord_user_id FROM room_members WHERE room_id = ? AND discord_user_id = ?', [req.params.id, req.session?.discordUserId || '']);
      if (!membership) return res.status(404).json({ error: 'Room not found.' });
    }
    res.json(snapshot);
  }));

  app.post('/api/rooms', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const name = sanitizeText(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: 'Room name is required.' });
    let media;
    try {
      media = classifyMediaUrl(req.body?.mediaUrl);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const user = await getUser(req.session.discordUserId);
    if (!user) return res.status(401).json({ error: 'Discord authentication required.' });
    const id = crypto.randomUUID();
    await database.run('INSERT INTO rooms (id, name, host_user_id, media_provider, media_url) VALUES (?, ?, ?, ?, ?)', [id, name, user.discord_user_id, media.provider, media.source_url]);
    await database.run('INSERT OR IGNORE INTO room_members (room_id, discord_user_id) VALUES (?, ?)', [id, user.discord_user_id]);
    const room = await database.get('SELECT r.*, u.display_name AS host_display_name, u.avatar AS host_avatar FROM rooms r LEFT JOIN users u ON u.discord_user_id = r.host_user_id WHERE r.id = ?', [id]);
    res.status(201).json({ room: publicRoom(room), media });
  }));

  app.post('/api/rooms/:id/join', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const room = await database.get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    if (!room || room.status !== 'live') return res.status(404).json({ error: 'Room not found.' });
    const existing = await database.get('SELECT discord_user_id FROM room_members WHERE room_id = ? AND discord_user_id = ?', [room.id, req.session.discordUserId]);
    if (!canJoinRoom(room, req.session.discordUserId, Boolean(existing))) return res.status(403).json({ error: 'This room is locked.' });
    await database.run('INSERT OR IGNORE INTO room_members (room_id, discord_user_id) VALUES (?, ?)', [room.id, req.session.discordUserId]);
    const snapshot = await roomSnapshot(room.id);
    res.json({ ok: true, room: snapshot.room });
  }));

  app.post('/api/rooms/:id/leave', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const room = await database.get('SELECT id FROM rooms WHERE id = ?', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    const clients = roomSockets.get(room.id) || new Set();
    for (const socket of [...clients]) {
      if (socket.userId === req.session.discordUserId) {
        sendSocket(socket, { type: 'force_leave', roomId: room.id });
        socket.close(1000, 'Member left room');
      }
    }
    await database.run('DELETE FROM room_members WHERE room_id = ? AND discord_user_id = ?', [room.id, req.session.discordUserId]);
    res.json({ ok: true });
  }));

  app.get('/api/rooms/:id/messages', requireAuth, asyncRoute(async (req, res) => {
    const membership = await database.get('SELECT discord_user_id FROM room_members WHERE room_id = ? AND discord_user_id = ?', [req.params.id, req.session.discordUserId]);
    if (!membership) return res.status(403).json({ error: 'Join the room to read its chat.' });
    const messages = await database.all('SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json({ messages: messages.reverse() });
  }));

  app.patch('/api/rooms/:id/media', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const roomHost = await requireRoomHost(req, res);
    if (!roomHost) return;
    let media;
    try {
      media = classifyMediaUrl(req.body?.mediaUrl);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    await database.run('UPDATE rooms SET media_provider = ?, media_url = ?, playback_state = ?, playback_position = 0, playback_updated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [media.provider, media.source_url, 'paused', new Date().toISOString(), roomHost.id]);
    const room = await database.get('SELECT r.*, u.display_name AS host_display_name, u.avatar AS host_avatar FROM rooms r LEFT JOIN users u ON u.discord_user_id = r.host_user_id WHERE r.id = ?', [roomHost.id]);
    broadcastRoom(room.id, { type: 'media_changed', roomId: room.id, room: publicRoom(room), media });
    res.json({ ok: true, room: publicRoom(room), media });
  }));

  app.patch('/api/rooms/:id/lock', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const roomHost = await requireRoomHost(req, res);
    if (!roomHost) return;
    const locked = Boolean(req.body?.locked);
    await database.run('UPDATE rooms SET locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [locked, roomHost.id]);
    broadcastRoom(roomHost.id, { type: 'room_locked', roomId: roomHost.id, locked });
    res.json({ ok: true, locked });
  }));

  app.post('/api/rooms/:id/end', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const roomHost = await requireRoomHost(req, res);
    if (!roomHost) return;
    const endedAt = new Date().toISOString();
    await database.run("UPDATE rooms SET status = 'ended', playback_state = 'ended', ended_at = ?, end_reason = 'host_ended', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [endedAt, roomHost.id]);
    broadcastRoom(roomHost.id, { type: 'room_ended', roomId: roomHost.id, endedAt, reason: 'host_ended' });
    res.json({ ok: true, roomId: roomHost.id, endedAt, reason: 'host_ended' });
  }));

  app.get('/api/events', asyncRoute(async (req, res) => {
    const events = await database.all("SELECT * FROM events WHERE status = 'upcoming' AND end_time > ? ORDER BY start_time ASC", [new Date().toISOString()]);
    res.json({ events });
  }));

  app.post('/api/events', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    if (!discordBot) return res.status(503).json({ error: 'Discord administration is unavailable right now.' });
    let allowed = false;
    try {
      allowed = await discordBot.isGuildAdministrator(req.session.discordUserId);
    } catch {
      allowed = false;
    }
    if (!allowed) return res.status(403).json({ error: 'Only the server owner or a server administrator can create events.' });

    const title = sanitizeText(req.body?.title, 100);
    const description = sanitizeText(req.body?.description, 500);
    const type = sanitizeText(req.body?.type, 40).toUpperCase() || 'COMMUNITY EVENT';
    const startTime = new Date(req.body?.startTime);
    const endTime = new Date(req.body?.endTime);
    if (!title || Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || startTime <= new Date() || endTime <= startTime) {
      return res.status(400).json({ error: 'Provide a title and a future event time range.' });
    }
    const user = await getUser(req.session.discordUserId);
    if (!user) return res.status(401).json({ error: 'Discord authentication required.' });
    const event = {
      id: crypto.randomUUID(),
      title,
      description,
      type,
      host: user.display_name,
      host_discord_user_id: user.discord_user_id,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      status: 'upcoming',
    };
    await database.run('INSERT INTO events (id, title, description, type, host, host_discord_user_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [event.id, event.title, event.description, event.type, event.host, event.host_discord_user_id, event.start_time, event.end_time, event.status]);
    res.status(201).json({ event });
  }));

  app.post('/api/events/:id/join', requireSameOrigin, requireAuth, asyncRoute(async (req, res) => {
    const event = await database.get("SELECT id FROM events WHERE id = ? AND status = 'upcoming'", [req.params.id]);
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    await database.run('INSERT OR IGNORE INTO event_participants (event_id, discord_user_id) VALUES (?, ?)', [event.id, req.session.discordUserId]);
    res.json({ ok: true, eventId: event.id });
  }));

  app.get('/api/games/daily-word', requireAuth, asyncRoute(async (req, res) => {
    const game = await getDailyGameState(req.session.discordUserId);
    res.json({ date: game.date, attempts: game.attempts, attemptsRemaining: game.attemptsRemaining, solved: game.solved, ...(game.solved ? { answer: game.answer } : {}), length: 5, status: 'ready' });
  }));

  app.post('/api/games/daily-word/guess', requireSameOrigin, requireAuth, guessLimiter, asyncRoute(async (req, res) => {
    const guess = String(req.body?.guess || '').toUpperCase();
    if (!/^[A-Z]{5}$/.test(guess)) return res.status(400).json({ error: 'Guess must be a 5-letter word.' });
    const dateKey = zenithDateKey();
    const game = await getDailyGameState(req.session.discordUserId, dateKey);
    if (game.solved) return res.status(409).json({ error: 'You already solved today’s puzzle.' });
    if (game.attempts.length >= 6) return res.status(409).json({ error: 'You have used all six attempts for today.' });
    const answer = (await database.get('SELECT word FROM daily_words WHERE date_key = ?', [dateKey])).word;
    const result = Array(5).fill('gray');
    const counts = {};
    for (const letter of answer) counts[letter] = (counts[letter] || 0) + 1;
    for (let index = 0; index < 5; index += 1) if (guess[index] === answer[index]) { result[index] = 'green'; counts[guess[index]] -= 1; }
    for (let index = 0; index < 5; index += 1) if (result[index] !== 'green' && counts[guess[index]] > 0) { result[index] = 'yellow'; counts[guess[index]] -= 1; }
    const solved = result.every((tile) => tile === 'green');
    const attempts = [...game.attempts, { guess, result }];
    await database.run(`INSERT INTO daily_game_attempts (date_key, discord_user_id, guesses, solved, guesses_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(date_key, discord_user_id) DO UPDATE SET guesses = excluded.guesses, solved = excluded.solved, guesses_json = excluded.guesses_json`,
      [dateKey, req.session.discordUserId, attempts.length, solved, JSON.stringify(attempts)]);

    const currentStreak = solved
      ? await refreshDailyStreak(req.session.discordUserId, dateKey)
      : Number((await getUser(req.session.discordUserId))?.current_streak || 0);

    res.json({
      solved,
      result,
      attemptsRemaining: Math.max(0, 6 - attempts.length),
      currentStreak,
      ...(solved ? { answer } : {}),
    });
  }));

  app.get('/api/admin', requireAuth, requireGuildAdmin, asyncRoute(async (req, res) => {
    const [users, rooms, events, tracking] = await Promise.all([
      database.all('SELECT discord_user_id, username, display_name, avatar, tracked_message_count, last_message_at FROM users ORDER BY tracked_message_count DESC LIMIT 100'),
      database.all('SELECT * FROM rooms ORDER BY created_at DESC LIMIT 100'),
      database.all('SELECT * FROM events ORDER BY start_time ASC LIMIT 100'),
      getTrackingInfo(),
    ]);
    res.json({ users, rooms: rooms.map(publicRoom), events, tracking });
  }));

  app.use('/css', express.static(path.join(__dirname, 'css'), { dotfiles: 'deny', fallthrough: false, maxAge: IS_PRODUCTION ? '1h' : 0 }));
  app.use('/js', express.static(path.join(__dirname, 'js'), { dotfiles: 'deny', fallthrough: false, maxAge: IS_PRODUCTION ? '1h' : 0 }));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((req, res) => res.status(404).send('Not found.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Request failed:', error.message);
    const parserStatus = Number(error.status || error.statusCode);
    if (parserStatus === 400) return res.status(400).json({ error: 'Malformed request body.' });
    if (parserStatus === 413) return res.status(413).json({ error: 'Request body is too large.' });
    res.status(500).json({ error: 'The request could not be completed.' });
  });

  return app;
}

function installWebSocketUpgrade(serverInstance) {
  serverInstance.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') return socket.destroy();
    const origin = request.headers.origin;
    if (IS_PRODUCTION && origin !== new URL(process.env.DISCORD_REDIRECT_URI).origin) return socket.destroy();
    const response = new http.ServerResponse(request);
    sessionMiddleware(request, response, () => {
      if (!request.session?.discordUserId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request));
    });
  });
}

let sessionMiddleware;
let sessionStore;

function attachSessionMiddleware() {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = database.isPostgres
    ? new PgSession({ conString: DATABASE_URL, tableName: 'user_sessions', createTableIfMissing: true })
    : new session.MemoryStore();
  sessionMiddleware = session({
    name: SESSION_COOKIE_NAME,
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: USE_SECURE_COOKIES, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 },
  });
}

async function ensureDiscordUser(discordUserId, userLike = {}) {
  const id = String(discordUserId);
  const username = String(userLike.username || 'discord-user').slice(0, 80);
  const displayName = String(userLike.displayName || userLike.globalName || username).slice(0, 100);
  const avatar = typeof userLike.displayAvatarURL === 'function'
    ? userLike.displayAvatarURL({ extension: 'png', size: 128 })
    : '';
  await database.run(
    `INSERT INTO users (discord_user_id, username, display_name, avatar, guild_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar, guild_id = excluded.guild_id, updated_at = CURRENT_TIMESTAMP`,
    [id, username, displayName, avatar, process.env.DISCORD_GUILD_ID]
  );
  await ensureUserSeason(database, id);
  return getUser(id);
}

async function handleDiscordLevelCommand(target, userLike) {
  if (target === 'study_vc') {
    return getStudyLeaderboard(database, process.env.DISCORD_GUILD_ID || 'unconfigured');
  }
  if (target === 'leaderboard') {
    await ensureUsersCurrentSeason(database, process.env.DISCORD_GUILD_ID || 'unconfigured');
    return database.all('SELECT display_name AS "displayName", username, season_xp AS xp, level, season_message_count AS messages, season_points AS points FROM users WHERE guild_id = ? AND season_key = ? ORDER BY season_xp DESC, season_message_count DESC, display_name ASC LIMIT 10', [process.env.DISCORD_GUILD_ID, getSeasonKey()]);
  }
  const user = await ensureDiscordUser(String(target), userLike || {});
  await ensureUserSeason(database, String(target));
  const current = await getUser(String(target));
  return { displayName: current.display_name || current.username, xp: Number(current.season_xp || 0), level: Math.floor(Math.sqrt(Number(current.season_xp || 0) / 100)) + 1, messages: Number(current.season_message_count || 0) };
}

async function handleStudyVoiceState(oldState, newState) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (oldState.guild?.id !== guildId && newState.guild?.id !== guildId) return;
  const studyChannelId = await getStudyVcChannelId(database);
  if (!studyChannelId) return;
  const oldInStudy = oldState.channelId === studyChannelId;
  const newInStudy = newState.channelId === studyChannelId;
  if (oldInStudy && !newInStudy) {
    await stopStudySession(database, oldState.id);
    return;
  }
  if (newInStudy && (!oldInStudy || oldState.channelId !== newState.channelId)) {
    if (newState.member?.user?.bot) return;
    await ensureDiscordUser(newState.id, newState.member?.user || {});
    await startStudySession(database, newState.id, studyChannelId);
  }
}

async function configureLeaderboard(interaction, type, channel) {
  if (type !== 'study_vc') return interaction.reply({ content: 'That leaderboard type is not available.', ephemeral: true });
  if (!channel.isVoiceBased()) return interaction.reply({ content: 'Choose a voice or stage channel.', ephemeral: true });
  const oldChannelId = await getStudyVcChannelId(database);
  if (oldChannelId && oldChannelId !== channel.id) {
    const sessions = await database.all('SELECT discord_user_id FROM study_vc_sessions');
    for (const session of sessions) await stopStudySession(database, session.discord_user_id);
  }
  await setStudyVcChannelId(database, channel.id);
  for (const member of channel.members.values()) {
    if (member.user.bot) continue;
    await ensureDiscordUser(member.id, member.user);
    await startStudySession(database, member.id, channel.id);
  }
  return interaction.reply({ content: 'Study VC leaderboard is now tracking **' + channel.name + '**. Use `/leaderboard` with **Study VC time** to view it.' });
}
function discordEventTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Invalid time' : '<t:' + Math.floor(date.getTime() / 1000) + ':F>';
}

async function handleDiscordEventCommand(interaction, subcommand) {
  if (subcommand === 'list') {
    const events = await database.all("SELECT id, title, description, type, start_time, end_time, status FROM events WHERE status = 'upcoming' AND end_time > ? ORDER BY start_time ASC LIMIT 10", [new Date().toISOString()]);
    if (!events.length) return interaction.reply({ content: 'There are no upcoming Zenith events.' });
    const lines = events.map((event) => '• **' + event.title + '** — ' + discordEventTime(event.start_time) + ' — ID: `' + event.id + '`');
    return interaction.reply({ content: '**Upcoming Zenith events**\n' + lines.join('\n') });
  }
  if (subcommand === 'cancel') {
    const eventId = interaction.options.getString('event_id', true);
    const event = await database.get("SELECT id, title FROM events WHERE id = ? AND status = 'upcoming'", [eventId]);
    if (!event) return interaction.reply({ content: 'That Zenith event does not exist or is already finished.', ephemeral: true });
    await database.run("UPDATE events SET status = 'cancelled' WHERE id = ?", [eventId]);
    return interaction.reply({ content: 'Cancelled **' + event.title + '** and removed it from the website calendar.' });
  }
  const title = sanitizeText(interaction.options.getString('title', true), 100);
  const description = sanitizeText(interaction.options.getString('description') || '', 500);
  const type = sanitizeText(interaction.options.getString('type') || 'COMMUNITY EVENT', 40).toUpperCase() || 'COMMUNITY EVENT';
  const startTime = parseCommandDate(interaction.options.getString('start', true));
  const endText = interaction.options.getString('end');
  const endTime = endText ? parseCommandDate(endText) : new Date(startTime.getTime() + 60 * 60 * 1000);
  if (!title || Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) return interaction.reply({ content: 'Invalid time. Use an ISO timestamp or `YYYY-MM-DD HH:mm` in the server timezone.', ephemeral: true });
  if (startTime <= new Date()) return interaction.reply({ content: 'The event must start in the future.', ephemeral: true });
  const user = await ensureDiscordUser(interaction.user.id, interaction.user);
  const host = user?.display_name || interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const id = crypto.randomUUID();
  const event = { id, title, description, type, host: String(host).slice(0, 100), host_discord_user_id: String(interaction.user.id), start_time: startTime.toISOString(), end_time: endTime.toISOString(), status: 'upcoming' };
  await database.run('INSERT INTO events (id, title, description, type, host, host_discord_user_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [event.id, event.title, event.description, event.type, event.host, event.host_discord_user_id, event.start_time, event.end_time, event.status]);
  return interaction.reply({ content: 'Added **' + event.title + '** to the Zenith website calendar.\nStarts ' + discordEventTime(event.start_time) + '\nEvent ID: `' + event.id + '`' });
}

function parseCommandDate(value) {
  const text = String(value || '').trim();
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return new Date(NaN);
  const [, year, month, day, hour, minute] = match;
  const zone = process.env.ZENITH_TIMEZONE || 'Asia/Colombo';
  const naive = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(naive);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const zoneAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
  return new Date(naive.getTime() - (zoneAsUtc - naive.getTime()));
}
async function startServer() {
  await database.initialize();
  if (BOT_CONFIGURED) {
    discordBot = createDiscordBot({
      token: process.env.DISCORD_BOT_TOKEN,
      guildId: process.env.DISCORD_GUILD_ID,
      onMessage: recordDiscordMessage,
      onLevel: handleDiscordLevelCommand,
      onEventCommand: handleDiscordEventCommand,
      onLeaderboardConfig: configureLeaderboard,
      onVoiceStateUpdate: handleStudyVoiceState,
      onReady: async (guild) => {
        await ensureUsersCurrentSeason(database, process.env.DISCORD_GUILD_ID || 'unconfigured');
        await database.run('INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [trackingDateKey(), new Date().toISOString()]);
        const studyChannelId = await getStudyVcChannelId(database);
        const studyChannel = studyChannelId ? guild.channels.cache.get(studyChannelId) : null;
        if (studyChannel?.isVoiceBased()) {
          for (const member of studyChannel.members.values()) {
            if (member.user.bot) continue;
            await ensureDiscordUser(member.id, member.user);
            await startStudySession(database, member.id, studyChannelId);
          }
        }
        if (studyFlushTimer) clearInterval(studyFlushTimer);
        studyFlushTimer = setInterval(() => {
          flushStudySessions(database).catch((error) => console.error('Study VC flush failed:', error.message));
        }, 30000);
        studyFlushTimer.unref?.();
      },
      onError: (error) => console.error('Discord bot error:', error.message),
    });
    await discordBot.ready;
  }

  attachSessionMiddleware();
  createApp();
  server = http.createServer(app);
  installWebSocketUpgrade(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  console.log(`Zenith server listening on port ${PORT}; database=${database.isPostgres ? 'postgresql' : 'development-sqlite'}; bot=${discordBot ? 'connected' : 'not-configured'}`);
  return { app, server };
}

wss.on('connection', (socket, request) => {
  socket.userId = request.session.discordUserId;
  socket.roomId = null;
  socket.isAlive = true;
  activeConnections.add(socket);
  const identityReady = getPublicUser(socket.userId).then((user) => {
    if (!user) {
      socket.close(1008, 'Discord identity is unavailable');
      throw new Error('Discord identity is unavailable.');
    }
    socket.user = user;
  });
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => {
    identityReady.then(() => handleRoomSocketMessage(socket, raw)).catch((error) => {
      console.error('Room WebSocket message failed:', error.message);
      sendSocket(socket, { type: 'error', error: 'The room action could not be completed.' });
    });
  });
  socket.on('close', () => {
    activeConnections.delete(socket);
    const cleanup = removeSocketFromRoom(socket).catch((error) => console.error('Room presence cleanup failed:', error.message));
    connectionCleanups.add(cleanup);
    cleanup.finally(() => connectionCleanups.delete(cleanup));
  });
  socket.on('error', (error) => console.error('Room WebSocket error:', error.message));
});

const heartbeat = setInterval(() => {
  for (const socket of activeConnections) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);
heartbeat.unref();

async function shutdown() {
  clearInterval(heartbeat);
  if (studyFlushTimer) clearInterval(studyFlushTimer);
  try { await flushStudySessions(database); } catch (error) { console.error('Study VC final flush failed:', error.message); }
  await Promise.all([...activeConnections].map((socket) => new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1500);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close(1001, 'Server shutting down');
  })));
  await Promise.all([...connectionCleanups]);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (discordBot) await discordBot.client.destroy();
  await database.close();
}

function installShutdownHandlers() {
  process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
}

if (require.main === module) {
  installShutdownHandlers();
  startServer().catch(async (error) => {
    console.error('Zenith startup failed:', error.message);
    try { await shutdown(); } catch (closeError) { console.error('Shutdown failed:', closeError.message); }
    process.exitCode = 1;
  });
}

module.exports = { database, getMessageLeaderboard, getSessionStore: () => sessionStore, installShutdownHandlers, shutdown, startServer };