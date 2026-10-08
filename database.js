'use strict';

const path = require('path');
const { getSeasonKey } = require('./season');

function createDatabase(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const usePostgres = /^postgres(?:ql)?:\/\//i.test(databaseUrl);
  let pool = null;
  let sqlite = null;

  if (usePostgres) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.PG_POOL_MAX || 10) });
  } else {
    // Node 22.5+ includes SQLite natively. Using node:sqlite avoids the
    // native sqlite3 npm addon, whose prebuilt binary is unavailable on
    // some managed hosting images such as WispByte's Node 22 image.
    const { DatabaseSync } = require('node:sqlite');
    const sqlitePath = options.sqlitePath || process.env.SQLITE_PATH || (databaseUrl || path.join(__dirname, 'zenith.db'));
    sqlite = new DatabaseSync(sqlitePath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
  }

  function translateForPostgres(sql, params) {
    let statement = sql.trim().replace(/;$/, '');
    const ignoreInsert = /^INSERT OR IGNORE INTO/i.test(statement);
    if (ignoreInsert) statement = statement.replace(/^INSERT OR IGNORE INTO/i, 'INSERT INTO');
    let index = 0;
    statement = statement.replace(/\?/g, () => `$${++index}`);
    if (ignoreInsert && !/\bON CONFLICT\b/i.test(statement)) statement += ' ON CONFLICT DO NOTHING';
    if (/^INSERT INTO room_messages\b/i.test(statement) && !/\bRETURNING\b/i.test(statement)) statement += ' RETURNING id';
    return { statement, params };
  }

  function sqliteParams(params) {
    return params.map((value) => {
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    });
  }

  function run(sql, params = []) {
    if (usePostgres) {
      const translated = translateForPostgres(sql, params);
      return pool.query(translated.statement, translated.params).then((result) => ({
        id: result.rows[0]?.id ?? null,
        changes: result.rowCount || 0,
      }));
    }
    const result = sqlite.prepare(sql).run(...sqliteParams(params));
    return Promise.resolve({
      id: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
      changes: Number(result.changes || 0),
    });
  }

  function get(sql, params = []) {
    if (usePostgres) {
      const translated = translateForPostgres(sql, params);
      return pool.query(translated.statement, translated.params).then((result) => result.rows[0] || null);
    }
    return Promise.resolve(sqlite.prepare(sql).get(...sqliteParams(params)) || null);
  }

  function all(sql, params = []) {
    if (usePostgres) {
      const translated = translateForPostgres(sql, params);
      return pool.query(translated.statement, translated.params).then((result) => result.rows || []);
    }
    return Promise.resolve(sqlite.prepare(sql).all(...sqliteParams(params)) || []);
  }

  async function migrateLegacySqliteUsers() {
    const oldTable = await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (!oldTable) return;

    const columns = await all('PRAGMA table_info(users)');
    if (columns.some((column) => column.name === 'discord_user_id')) return;

    await run('ALTER TABLE users RENAME TO users_legacy');
    await createSqliteUsersTable();
    const oldUsers = await all('SELECT * FROM users_legacy');
    for (const user of oldUsers) {
      const discordUserId = String(user.discord_id || user.id || '');
      if (!/^\d{17,20}$/.test(discordUserId)) continue;
      await run(
        `INSERT INTO users (discord_user_id, username, display_name, avatar, guild_id, tracked_message_count, last_message_at, xp, points, level, movie_nights, music_nights, game_wins, current_streak, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
         ON CONFLICT(discord_user_id) DO NOTHING`,
        [discordUserId, user.username || 'discord-user', user.display_name || user.username || 'Discord member', user.avatar || '', process.env.DISCORD_GUILD_ID || 'unconfigured', Number(user.xp || 0), Number(user.points || 0), Number(user.level || 1), Number(user.movie_nights || 0), Number(user.music_nights || 0), Number(user.game_wins || 0), Number(user.current_streak || 0), user.created_at || null]
      );
    }
    await run('DROP TABLE users_legacy');
    await createSqliteSchema();
  }

  async function createSqliteUsersTable() {
    await run(`CREATE TABLE IF NOT EXISTS users (
        discord_user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        guild_id TEXT NOT NULL,
        tracked_message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        last_xp_at TEXT,
        xp INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        movie_nights INTEGER NOT NULL DEFAULT 0,
        music_nights INTEGER NOT NULL DEFAULT 0,
        game_wins INTEGER NOT NULL DEFAULT 0,
        current_streak INTEGER NOT NULL DEFAULT 0,
        season_key TEXT,
        season_xp INTEGER NOT NULL DEFAULT 0,
        season_points INTEGER NOT NULL DEFAULT 0,
        season_message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  }

  async function createSqliteSchema() {
    await createSqliteUsersTable();
    const statements = [
      `CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_user_id TEXT NOT NULL REFERENCES users(discord_user_id),
        media_provider TEXT NOT NULL,
        media_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'live',
        locked INTEGER NOT NULL DEFAULT 0,
        playback_state TEXT NOT NULL DEFAULT 'paused',
        playback_position REAL NOT NULL DEFAULT 0,
        playback_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TEXT,
        end_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS room_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'COMMUNITY EVENT',
        host TEXT NOT NULL,
        host_discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'upcoming',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS event_participants (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS discord_message_events (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS daily_words (
        date_key TEXT PRIMARY KEY,
        word TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS daily_game_attempts (
        date_key TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        guesses INTEGER NOT NULL DEFAULT 0,
        solved INTEGER NOT NULL DEFAULT 0,
        guesses_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (date_key, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS mission_claims (
        mission_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        xp_reward INTEGER NOT NULL DEFAULT 0,
        points_reward INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mission_id, discord_user_id, period_key)
      )`,
      `CREATE TABLE IF NOT EXISTS discord_invite_uses (\n        guild_id TEXT NOT NULL,\n        invite_code TEXT NOT NULL,\n        inviter_discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,\n        invited_discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,\n        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n        PRIMARY KEY (guild_id, invite_code, invited_discord_user_id)\n      )`,\n      `CREATE TABLE IF NOT EXISTS study_vc_time (
        discord_user_id TEXT PRIMARY KEY REFERENCES users(discord_user_id) ON DELETE CASCADE,
        seconds INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS study_vc_sessions (
        discord_user_id TEXT PRIMARY KEY REFERENCES users(discord_user_id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        joined_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_badges (
        badge_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (badge_id, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS season_badges (
        badge_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        season_key TEXT NOT NULL,
        unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (badge_id, discord_user_id, season_key)
      )`,
      `CREATE TABLE IF NOT EXISTS season_study_vc_time (
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        season_key TEXT NOT NULL,
        seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (discord_user_id, season_key)
      )`,
      `CREATE TABLE IF NOT EXISTS season_history (
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        season_key TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        study_seconds INTEGER NOT NULL DEFAULT 0,
        badge_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (discord_user_id, season_key)
      )`,
    ];
    for (const statement of statements) await run(statement);
    const userColumns = await all('PRAGMA table_info(users)');
    const existingUserColumns = new Set(userColumns.map((column) => column.name));
    if (!existingUserColumns.has('last_xp_at')) await run('ALTER TABLE users ADD COLUMN last_xp_at TEXT');
    if (!existingUserColumns.has('season_key')) await run('ALTER TABLE users ADD COLUMN season_key TEXT');
    if (!existingUserColumns.has('season_xp')) await run('ALTER TABLE users ADD COLUMN season_xp INTEGER NOT NULL DEFAULT 0');
    if (!existingUserColumns.has('season_points')) await run('ALTER TABLE users ADD COLUMN season_points INTEGER NOT NULL DEFAULT 0');
    if (!existingUserColumns.has('season_message_count')) await run('ALTER TABLE users ADD COLUMN season_message_count INTEGER NOT NULL DEFAULT 0');
    await run('UPDATE users SET season_key = ?, season_xp = xp, season_points = points, season_message_count = tracked_message_count WHERE season_key IS NULL', [getSeasonKey()]);

    const roomColumns = await all('PRAGMA table_info(rooms)');
    const existingRoomColumns = new Set(roomColumns.map((column) => column.name));
    const roomMigrations = [
      ['media_provider', "TEXT NOT NULL DEFAULT 'direct_video'"],
      ['playback_state', "TEXT NOT NULL DEFAULT 'paused'"],
      ['playback_position', 'REAL NOT NULL DEFAULT 0'],
      ['playback_updated_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
      ['ended_at', 'TEXT'],
      ['end_reason', 'TEXT'],
    ];
    for (const [column, definition] of roomMigrations) {
      if (!existingRoomColumns.has(column)) await run(`ALTER TABLE rooms ADD COLUMN ${column} ${definition}`);
    }

    const memberColumns = await all('PRAGMA table_info(room_members)');
    if (memberColumns.length && !memberColumns.some((column) => column.name === 'discord_user_id')) {
      await run('ALTER TABLE room_members RENAME TO room_members_legacy');
      await run(`CREATE TABLE room_members (
        room_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, discord_user_id)
      )`);
      const members = await all('SELECT * FROM room_members_legacy');
      for (const member of members) {
        const user = await get('SELECT discord_user_id FROM users WHERE discord_user_id = ?', [member.user_id]);
        if (user) await run('INSERT OR IGNORE INTO room_members (room_id, discord_user_id, joined_at) VALUES (?, ?, ?)', [member.room_id, user.discord_user_id, member.joined_at]);
      }
      await run('DROP TABLE room_members_legacy');
    }

    const messageColumns = await all('PRAGMA table_info(room_messages)');
    if (messageColumns.length && !messageColumns.some((column) => column.name === 'discord_user_id')) {
      await run('ALTER TABLE room_messages RENAME TO room_messages_legacy');
      await run(`CREATE TABLE room_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      const messages = await all('SELECT * FROM room_messages_legacy');
      for (const message of messages) {
        const discordUserId = String(message.user_id || '');
        const user = await get('SELECT discord_user_id FROM users WHERE discord_user_id = ?', [discordUserId]);
        if (user) await run('INSERT INTO room_messages (room_id, discord_user_id, username, avatar, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', [message.room_id, discordUserId, message.username || 'Discord member', message.avatar || '', message.content || '', message.created_at || new Date().toISOString()]);
      }
      await run('DROP TABLE room_messages_legacy');
    }

    const eventColumns = await all('PRAGMA table_info(events)');
    if (eventColumns.length && !eventColumns.some((column) => column.name === 'host_discord_user_id')) {
      await run('ALTER TABLE events ADD COLUMN host_discord_user_id TEXT');
      await run("DELETE FROM events WHERE host_discord_user_id IS NULL");
    }
    const participantColumns = await all('PRAGMA table_info(event_participants)');
    if (participantColumns.length && !participantColumns.some((column) => column.name === 'discord_user_id')) {
      await run('ALTER TABLE event_participants RENAME TO event_participants_legacy');
      await run(`CREATE TABLE event_participants (
        event_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, discord_user_id)
      )`);
      const participants = await all('SELECT * FROM event_participants_legacy');
      for (const participant of participants) {
        const user = await get('SELECT discord_user_id FROM users WHERE discord_user_id = ?', [participant.user_id]);
        const event = await get('SELECT id FROM events WHERE id = ?', [participant.event_id]);
        if (user && event) await run('INSERT OR IGNORE INTO event_participants (event_id, discord_user_id, joined_at) VALUES (?, ?, ?)', [event.id, user.discord_user_id, participant.joined_at]);
      }
      await run('DROP TABLE event_participants_legacy');
    }

    await run('CREATE INDEX IF NOT EXISTS idx_discord_events_guild_created ON discord_message_events (guild_id, created_at)');
    await run('CREATE INDEX IF NOT EXISTS idx_discord_events_author_created ON discord_message_events (author_discord_user_id, created_at)');
    await run('CREATE INDEX IF NOT EXISTS idx_room_messages_room_created ON room_messages (room_id, created_at)');
    await run("DELETE FROM room_messages WHERE discord_user_id = 'demo-user'");
    await run("DELETE FROM room_members WHERE discord_user_id = 'demo-user'");
    await run("DELETE FROM event_participants WHERE discord_user_id = 'demo-user'");
    await run("DELETE FROM rooms WHERE id IN ('room-1', 'room-2') AND host_user_id = 'demo-user'");
    await run("DELETE FROM events WHERE id IN ('event-1', 'event-2') AND host = 'Demo User'");
  }

  async function initialize() {
    if (!usePostgres) {
      await migrateLegacySqliteUsers();
      await createSqliteSchema();
      return;
    }

    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        discord_user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        guild_id TEXT NOT NULL,
        tracked_message_count BIGINT NOT NULL DEFAULT 0,
        last_message_at TIMESTAMPTZ,
        last_xp_at TIMESTAMPTZ,
        xp INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        movie_nights INTEGER NOT NULL DEFAULT 0,
        music_nights INTEGER NOT NULL DEFAULT 0,
        game_wins INTEGER NOT NULL DEFAULT 0,
        current_streak INTEGER NOT NULL DEFAULT 0,
        season_key TEXT,
        season_xp INTEGER NOT NULL DEFAULT 0,
        season_points INTEGER NOT NULL DEFAULT 0,
        season_message_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_user_id TEXT NOT NULL REFERENCES users(discord_user_id),
        media_provider TEXT NOT NULL,
        media_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'live',
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        playback_state TEXT NOT NULL DEFAULT 'paused',
        playback_position DOUBLE PRECISION NOT NULL DEFAULT 0,
        playback_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        end_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (room_id, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS room_messages (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'COMMUNITY EVENT',
        host TEXT NOT NULL,
        host_discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id),
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'upcoming',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS event_participants (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS discord_message_events (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS daily_words (
        date_key TEXT PRIMARY KEY,
        word TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS daily_game_attempts (
        date_key TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        guesses INTEGER NOT NULL DEFAULT 0,
        solved BOOLEAN NOT NULL DEFAULT FALSE,
        guesses_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (date_key, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS mission_claims (
        mission_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        xp_reward INTEGER NOT NULL DEFAULT 0,
        points_reward INTEGER NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (mission_id, discord_user_id, period_key)
      )`,
      `CREATE TABLE IF NOT EXISTS study_vc_time (
        discord_user_id TEXT PRIMARY KEY REFERENCES users(discord_user_id) ON DELETE CASCADE,
        seconds BIGINT NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS study_vc_sessions (
        discord_user_id TEXT PRIMARY KEY REFERENCES users(discord_user_id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_badges (
        badge_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (badge_id, discord_user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS season_badges (
        badge_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        season_key TEXT NOT NULL,
        unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (badge_id, discord_user_id, season_key)
      )`,
      `CREATE TABLE IF NOT EXISTS season_study_vc_time (
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        season_key TEXT NOT NULL,
        seconds BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (discord_user_id, season_key)
      )`,
      `CREATE TABLE IF NOT EXISTS season_history (
        discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
        season_key TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        messages BIGINT NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        study_seconds BIGINT NOT NULL DEFAULT 0,
        badge_count INTEGER NOT NULL DEFAULT 0,
        archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (discord_user_id, season_key)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_discord_events_guild_created ON discord_message_events (guild_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_discord_events_author_created ON discord_message_events (author_discord_user_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_room_messages_room_created ON room_messages (room_id, created_at)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_xp_at TIMESTAMPTZ',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS season_key TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS season_xp INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS season_points INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS season_message_count BIGINT NOT NULL DEFAULT 0',
      'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS media_provider TEXT NOT NULL DEFAULT \'direct_video\'',
      'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS playback_state TEXT NOT NULL DEFAULT \'paused\'',
      'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS playback_position DOUBLE PRECISION NOT NULL DEFAULT 0',
      'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS playback_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ',
      'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS end_reason TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS host_discord_user_id TEXT',
      'UPDATE events SET host_discord_user_id = \'\' WHERE host_discord_user_id IS NULL',
      'UPDATE users SET season_key = $1, season_xp = xp, season_points = points, season_message_count = tracked_message_count WHERE season_key IS NULL',
    ];
    for (const statement of statements) {
      if (statement.startsWith('UPDATE users SET season_key = $1')) {
        await pool.query(statement, [getSeasonKey()]);
      } else {
        await run(statement);
      }
    }
    await run("DELETE FROM room_messages WHERE discord_user_id = 'demo-user'");
    await run("DELETE FROM room_members WHERE discord_user_id = 'demo-user'");
    await run("DELETE FROM event_participants WHERE discord_user_id = 'demo-user'");
    await run("DELETE FROM rooms WHERE id IN ('room-1', 'room-2') AND host_user_id = 'demo-user'");
    await run("DELETE FROM events WHERE id IN ('event-1', 'event-2') AND host = 'Demo User'");
    await run("DELETE FROM users WHERE discord_user_id = 'demo-user'");
  }

  async function close() {
    if (pool) await pool.end();
    if (sqlite) sqlite.close();
  }

  return { all, close, get, initialize, isPostgres: usePostgres, run };
}

module.exports = { createDatabase };