'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { productionConfigErrors } = require('../production-config');
const { classifyMediaUrl, UNSUPPORTED_MEDIA_MESSAGE } = require('../media');
const { leaderboardWindowStart } = require('../leaderboard');
const { createDatabase } = require('../database');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { COMMANDS, isTrackableMessage } = require('../discord-bot');
const { getDiscordLeaderboard, recordGuildMessage } = require('../discord-activity');
const { canJoinRoom, isRoomHost } = require('../room-policy');

test('production refuses to start without required Discord and database settings', () => {
  const errors = productionConfigErrors({ NODE_ENV: 'production' });
  assert.equal(errors.length, 7);
  assert.ok(errors.some((error) => error.startsWith('DISCORD_BOT_TOKEN')));
});

test('development config does not silently enable any authentication fallback', () => {
  assert.deepEqual(productionConfigErrors({ NODE_ENV: 'development' }), []);
});

test('explicit insecure HTTP production mode permits HTTP OAuth and SQLite', () => {
  const errors = productionConfigErrors({
    NODE_ENV: 'production',
    ALLOW_INSECURE_HTTP: 'true',
    DISCORD_CLIENT_ID: '12345678901234567',
    DISCORD_CLIENT_SECRET: 'secret',
    DISCORD_REDIRECT_URI: 'http://127.0.0.1:3000/auth/discord/callback',
    DISCORD_BOT_TOKEN: 'token',
    DISCORD_GUILD_ID: '12345678901234568',
    SESSION_SECRET: 'this-is-a-long-enough-session-secret-for-http-mode',
  });
  assert.deepEqual(errors, []);
});

test('production requires a secure OAuth callback, strong session secret, and PostgreSQL URL', () => {
  const errors = productionConfigErrors({
    NODE_ENV: 'production',
    DISCORD_CLIENT_ID: '12345678901234567',
    DISCORD_CLIENT_SECRET: 'secret',
    DISCORD_REDIRECT_URI: 'http://zenith.example/auth/discord/callback',
    DISCORD_BOT_TOKEN: 'token',
    DISCORD_GUILD_ID: '12345678901234568',
    SESSION_SECRET: 'short',
    DATABASE_URL: 'zenith.db',
  });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => error.includes('HTTPS')));
  assert.ok(errors.some((error) => error.includes('32 characters')));
  assert.ok(errors.some((error) => error.includes('PostgreSQL')));
});

test('media classifier accepts direct HTTPS video and signed query strings', () => {
  const media = classifyMediaUrl('https://cdn.example/movie.mp4?token=temporary');
  assert.equal(media.provider, 'direct_video');
  assert.equal(media.source_url, 'https://cdn.example/movie.mp4?token=temporary');
});

test('media classifier maps supported YouTube and Vimeo URLs to official embeds', () => {
  assert.equal(classifyMediaUrl('https://youtu.be/abcdefghijk').embed_url, 'https://www.youtube-nocookie.com/embed/abcdefghijk?enablejsapi=1');
  assert.equal(classifyMediaUrl('https://vimeo.com/1234567').embed_url, 'https://player.vimeo.com/video/1234567?api=1');
});

test('media classifier rejects unsupported sites and insecure URLs with an actionable error', () => {
  for (const url of ['https://example.com/watch', 'http://cdn.example/movie.mp4', 'javascript:alert(1)']) {
    assert.throws(() => classifyMediaUrl(url), { message: UNSUPPORTED_MEDIA_MESSAGE });
  }
});

test('leaderboard date windows are UTC and periods are exact', () => {
  const now = new Date('2026-10-08T20:20:00.000Z');
  assert.equal(leaderboardWindowStart('today', now), '2026-10-08T00:00:00.000Z');
  assert.equal(leaderboardWindowStart('this_week', now), '2026-10-05T00:00:00.000Z');
  assert.equal(leaderboardWindowStart('this_month', now), '2026-10-01T00:00:00.000Z');
  assert.equal(leaderboardWindowStart('all_time', now), null);
  assert.throws(() => leaderboardWindowStart('year', now));
});

test('SQLite development schema stores Discord identities and tracked message events', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-db-'));
  const database = createDatabase({ sqlitePath: path.join(directory, 'test.db') });
  context.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await database.initialize();
  const tables = await database.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  assert.ok(tables.some((table) => table.name === 'discord_message_events'));
  const columns = await database.all('PRAGMA table_info(users)');
  assert.ok(columns.some((column) => column.name === 'discord_user_id'));
  assert.ok(!columns.some((column) => column.name === 'admin'));
});

test('legacy SQLite migration preserves real Discord snowflakes and drops seeded demo users', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-legacy-'));
  const databasePath = path.join(directory, 'legacy.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT, avatar TEXT,
    discord_id TEXT, xp INTEGER DEFAULT 0, points INTEGER DEFAULT 0, level INTEGER DEFAULT 1,
    messages_sent INTEGER DEFAULT 0, movie_nights INTEGER DEFAULT 0, music_nights INTEGER DEFAULT 0,
    game_wins INTEGER DEFAULT 0, current_streak INTEGER DEFAULT 0, admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO users (id, username, display_name, discord_id, messages_sent, admin)
  VALUES ('12345678901234567', 'real-member', 'Real Member', '12345678901234567', 500, 1);
  INSERT INTO users (id, username, display_name, discord_id, messages_sent, admin)
  VALUES ('demo-user', 'demo-user', 'Demo User', 'demo-user', 120, 1);
  CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, host_user_id TEXT, media_url TEXT, media_type TEXT, status TEXT, locked INTEGER, created_at TEXT, updated_at TEXT);
  INSERT INTO rooms (id, name, host_user_id, media_url, media_type, status, locked) VALUES ('room-1', 'Seed room', 'demo-user', 'https://old.example/video.mp4', 'video', 'live', 0);
  INSERT INTO rooms (id, name, host_user_id, media_url, media_type, status, locked) VALUES ('real-room', 'Real room', '12345678901234567', 'https://cdn.example/real.mp4', 'video', 'live', 0);
  CREATE TABLE room_members (room_id TEXT, user_id TEXT, joined_at TEXT, PRIMARY KEY (room_id, user_id));
  INSERT INTO room_members VALUES ('room-1', 'demo-user', CURRENT_TIMESTAMP);
  INSERT INTO room_members VALUES ('real-room', '12345678901234567', CURRENT_TIMESTAMP);
  CREATE TABLE room_messages (id INTEGER PRIMARY KEY, room_id TEXT, user_id TEXT, username TEXT, avatar TEXT, content TEXT, created_at TEXT);
  INSERT INTO room_messages VALUES (1, 'room-1', 'demo-user', 'demo-user', '', 'seed message', CURRENT_TIMESTAMP);
  INSERT INTO room_messages VALUES (2, 'real-room', '12345678901234567', 'real-member', '', 'real message', CURRENT_TIMESTAMP);
  CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, description TEXT, type TEXT, host TEXT, start_time TEXT, end_time TEXT, status TEXT, xp_reward INTEGER DEFAULT 0, point_reward INTEGER DEFAULT 0, created_at TEXT);
  INSERT INTO events (id, title, host, start_time, end_time, status) VALUES ('event-1', 'Seed event', 'Demo User', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'upcoming');
  INSERT INTO events (id, title, host, start_time, end_time, status) VALUES ('real-event', 'Real event', 'Real Member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'upcoming');
  CREATE TABLE event_participants (event_id TEXT, user_id TEXT, joined_at TEXT, PRIMARY KEY (event_id, user_id));
  INSERT INTO event_participants VALUES ('event-1', 'demo-user', CURRENT_TIMESTAMP);
  INSERT INTO event_participants VALUES ('real-event', '12345678901234567', CURRENT_TIMESTAMP);`);
  legacy.close();

  const database = createDatabase({ sqlitePath: databasePath });
  context.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await database.initialize();

  const members = await database.all('SELECT * FROM users');
  assert.equal(members.length, 1);
  assert.equal(members[0].discord_user_id, '12345678901234567');
  assert.equal(Number(members[0].tracked_message_count), 0);
  assert.equal(members[0].admin, undefined);
  assert.deepEqual((await database.all('SELECT id FROM rooms')).map((room) => room.id), ['real-room']);
  assert.deepEqual((await database.all('SELECT id FROM events')).map((event) => event.id), ['real-event']);
  assert.equal((await database.all('SELECT * FROM room_messages')).length, 1);
  assert.equal((await database.all('SELECT * FROM event_participants')).length, 1);
});

test('daily game storage persists per-user attempts across database reads', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-daily-game-'));
  const database = createDatabase({ sqlitePath: path.join(directory, 'daily.db') });
  context.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await database.initialize();

  const userId = '12345678901234567';
  await database.run(
    'INSERT INTO users (discord_user_id, username, display_name, avatar, guild_id) VALUES (?, ?, ?, ?, ?)',
    [userId, 'player', 'Player', '', '22222222222222222']
  );
  await database.run('INSERT INTO daily_words (date_key, word) VALUES (?, ?)', ['2026-10-08', 'PLANT']);
  await database.run(
    'INSERT INTO daily_game_attempts (date_key, discord_user_id, guesses, solved, guesses_json) VALUES (?, ?, ?, ?, ?)',
    ['2026-10-08', userId, 1, 0, JSON.stringify([{ guess: 'STONE', result: ['gray', 'gray', 'green', 'gray', 'gray'] }])]
  );

  const saved = await database.get(
    'SELECT guesses, solved, guesses_json FROM daily_game_attempts WHERE date_key = ? AND discord_user_id = ?',
    ['2026-10-08', userId]
  );
  assert.equal(Number(saved.guesses), 1);
  assert.equal(Number(saved.solved), 0);
  assert.equal(JSON.parse(saved.guesses_json)[0].guess, 'STONE');
});

test('Discord commands expose level, leaderboard, and website event management', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.deepEqual(names, ['level', 'leaderboard', 'event']);
  const event = COMMANDS.find((command) => command.name === 'event');
  assert.deepEqual(event.options.map((option) => option.name), ['add', 'list', 'cancel']);
  assert.ok(event.options.find((option) => option.name === 'add').options.some((option) => option.name === 'start'));
});

test('Zenith leveling awards XP only once per cooldown window', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-levels-'));
  const database = createDatabase({ sqlitePath: path.join(directory, 'levels.db') });
  context.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await database.initialize();

  const guildId = '22222222222222222';
  const userId = '12345678901234567';
  const makeMessage = (id, date) => ({
    id,
    guildId,
    channelId: '33333333333333333',
    author: { id: userId, username: 'player', globalName: 'Player', bot: false, displayAvatarURL: () => '' },
    member: { displayName: 'Player' },
    createdAt: new Date(date),
  });

  assert.equal(await recordGuildMessage(database, makeMessage('m1', '2026-10-08T10:00:00.000Z'), guildId), true);
  assert.equal(await recordGuildMessage(database, makeMessage('m2', '2026-10-08T10:00:30.000Z'), guildId), true);
  const user = await database.get('SELECT xp, level, points, tracked_message_count FROM users WHERE discord_user_id = ?', [userId]);
  assert.equal(Number(user.xp), 15);
  assert.equal(Number(user.level), 1);
  assert.equal(Number(user.points), 2);
  assert.equal(Number(user.tracked_message_count), 2);
});


test('Zenith leveling cannot double-award XP when messages arrive concurrently', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-level-race-'));
  const database = createDatabase({ sqlitePath: path.join(directory, 'levels.db') });
  context.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await database.initialize();

  const guildId = '22222222222222222';
  const userId = '12345678901234567';
  const makeMessage = (id) => ({
    id,
    guildId,
    channelId: '33333333333333333',
    author: { id: userId, username: 'player', globalName: 'Player', bot: false, displayAvatarURL: () => '' },
    member: { displayName: 'Player' },
    createdAt: new Date('2026-10-08T10:00:00.000Z'),
  });

  const results = await Promise.all([
    recordGuildMessage(database, makeMessage('race-1'), guildId),
    recordGuildMessage(database, makeMessage('race-2'), guildId),
  ]);
  assert.deepEqual(results, [true, true]);
  const user = await database.get('SELECT xp, points, tracked_message_count FROM users WHERE discord_user_id = ?', [userId]);
  assert.equal(Number(user.xp), 15);
  assert.equal(Number(user.points), 2);
  assert.equal(Number(user.tracked_message_count), 2);
});

test('Discord activity accepts only real human messages from the configured guild', () => {
  const message = {
    id: 'message-id',
    guildId: 'guild-id',
    channelId: 'channel-id',
    author: { id: '12345678901234567', bot: false },
    createdAt: new Date('2026-10-08T12:00:00.000Z'),
  };
  assert.equal(isTrackableMessage(message, 'guild-id'), true);
  assert.equal(isTrackableMessage({ ...message, guildId: 'other-guild' }, 'guild-id'), false);
  assert.equal(isTrackableMessage({ ...message, author: { ...message.author, bot: true } }, 'guild-id'), false);
  assert.equal(isTrackableMessage({ ...message, author: { bot: false } }, 'guild-id'), false);
});

test('Discord message ledger deduplicates events and computes every period from tracked events', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-activity-'));
  const database = createDatabase({ sqlitePath: path.join(directory, 'activity.db') });
  context.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await database.initialize();

  const guildId = '22222222222222222';
  const memberOne = '12345678901234567';
  const memberTwo = '12345678901234568';
  const message = (id, authorId, date, bot = false) => ({
    id,
    guildId,
    channelId: '33333333333333333',
    author: {
      id: authorId,
      username: authorId === memberOne ? 'member-one' : 'member-two',
      globalName: authorId === memberOne ? 'Member One' : 'Member Two',
      bot,
      displayAvatarURL: () => '',
    },
    member: { displayName: authorId === memberOne ? 'Member One' : 'Member Two' },
    createdAt: new Date(date),
  });

  const events = [
    message('msg-1', memberOne, '2026-10-08T10:00:00.000Z'),
    message('msg-2', memberOne, '2026-10-08T11:00:00.000Z'),
    message('msg-3', memberTwo, '2026-10-08T12:00:00.000Z'),
    message('msg-4', memberOne, '2026-10-07T12:00:00.000Z'),
    message('msg-5', memberOne, '2026-10-02T12:00:00.000Z'),
    message('msg-6', memberTwo, '2026-10-02T13:00:00.000Z'),
    message('msg-7', memberOne, '2026-08-01T12:00:00.000Z'),
  ];
  for (const event of events) assert.equal(await recordGuildMessage(database, event, guildId), true);
  assert.equal(await recordGuildMessage(database, events[0], guildId), false);
  assert.equal(await recordGuildMessage(database, message('msg-bot', memberTwo, '2026-10-08T13:00:00.000Z', true), guildId), false);

  const now = new Date('2026-10-08T20:20:00.000Z');
  const today = await getDiscordLeaderboard(database, guildId, 'today', now);
  const week = await getDiscordLeaderboard(database, guildId, 'this_week', now);
  const month = await getDiscordLeaderboard(database, guildId, 'this_month', now);
  const allTime = await getDiscordLeaderboard(database, guildId, 'all_time', now);
  assert.deepEqual(today.map((user) => Number(user.message_count)), [2, 1]);
  assert.deepEqual(week.map((user) => Number(user.message_count)), [3, 1]);
  assert.deepEqual(month.map((user) => Number(user.message_count)), [4, 2]);
  assert.deepEqual(allTime.map((user) => Number(user.message_count)), [5, 2]);
  const member = await database.get('SELECT tracked_message_count, last_message_at FROM users WHERE discord_user_id = ?', [memberOne]);
  assert.equal(Number(member.tracked_message_count), 5);
  assert.equal(member.last_message_at, '2026-10-08T11:00:00.000Z');
});

test('room access and host authority use the stored Discord user ID', () => {
  const room = { host_user_id: '12345678901234567', status: 'live', locked: true };
  assert.equal(isRoomHost(room, '12345678901234567'), true);
  assert.equal(isRoomHost(room, 'different-user'), false);
  assert.equal(canJoinRoom(room, '12345678901234567', false), true);
  assert.equal(canJoinRoom(room, 'different-user', false), false);
  assert.equal(canJoinRoom(room, 'different-user', true), true);
  assert.equal(canJoinRoom({ ...room, status: 'ended' }, '12345678901234567', true), false);
});