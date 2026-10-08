'use strict';

const { isTrackableMessage } = require('./discord-bot');
const { leaderboardWindowStart } = require('./leaderboard');
const { getSeasonBounds, getSeasonKey, ensureUserSeason } = require('./season');

async function recordGuildMessage(database, message, guildId) {
  if (!isTrackableMessage(message, guildId)) return false;

  const discordUserId = String(message.author.id);
  const username = String(message.author.username || 'discord-user').trim().slice(0, 80);
  const displayName = String(message.member?.displayName || message.author.globalName || username).trim().slice(0, 100);
  const avatar = typeof message.author.displayAvatarURL === 'function'
    ? message.author.displayAvatarURL({ extension: 'png', size: 128 })
    : '';
  const createdAt = message.createdAt.toISOString();

  await database.run(
    `INSERT INTO users (discord_user_id, username, display_name, avatar, guild_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar = excluded.avatar,
       guild_id = excluded.guild_id,
       updated_at = CURRENT_TIMESTAMP`,
    [discordUserId, username, displayName, avatar, guildId]
  );

  await ensureUserSeason(database, discordUserId);

  const inserted = await database.run(
    'INSERT OR IGNORE INTO discord_message_events (message_id, guild_id, channel_id, author_discord_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [String(message.id), guildId, String(message.channelId), discordUserId, createdAt]
  );
  if (!inserted.changes) return false;

  const processedAt = Date.now();
  const messageTime = new Date(createdAt).getTime();
  const xpWindowStart = new Date(processedAt - 60_000).toISOString();

  await database.run(
    `UPDATE users SET tracked_message_count = tracked_message_count + 1,
     season_message_count = season_message_count + 1,
     points = points + 1,
     season_points = season_points + 1,
     last_message_at = CASE WHEN last_message_at IS NULL OR last_message_at < ? THEN ? ELSE last_message_at END,
     updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?`,
    [createdAt, createdAt, discordUserId]
  );

  // Claim the XP cooldown atomically. This prevents two near-simultaneous
  // Discord messages from both awarding XP based on the same old timestamp.
  const xpClaim = await database.run(
    `UPDATE users SET last_xp_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE discord_user_id = ?
       AND (last_xp_at IS NULL OR last_xp_at <= ?)`,
    [new Date(processedAt).toISOString(), discordUserId, xpWindowStart]
  );

  if (xpClaim.changes) {
    const userState = await database.get(
      'SELECT xp, season_xp FROM users WHERE discord_user_id = ?',
      [discordUserId]
    );
    const newXp = Number(userState?.xp || 0) + 15;
    const newSeasonXp = Number(userState?.season_xp || 0) + 15;
    const newLevel = Math.floor(Math.sqrt(newSeasonXp / 100)) + 1;
    await database.run(
      'UPDATE users SET xp = ?, season_xp = ?, level = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?',
      [newXp, newSeasonXp, newLevel, discordUserId]
    );
  }
  return true;
}

async function getDiscordLeaderboard(database, guildId, period = 'all_time', now = new Date()) {
  const start = leaderboardWindowStart(period, now);
  const seasonKey = getSeasonKey(now);
  const seasonStart = getSeasonBounds(now).start.toISOString();
  const params = [guildId];
  let messageExpression = 'u.season_message_count';
  let windowClause = '';
  if (start && period !== 'this_month') {
    messageExpression = 'COUNT(e.message_id)';
    windowClause = ' AND e.created_at >= ? AND e.created_at >= ?';
    params.push(start, seasonStart, guildId, seasonKey);
  }
  return database.all(
    `SELECT u.discord_user_id AS id, u.username, u.display_name, u.avatar,
       ${messageExpression} AS message_count, MAX(e.created_at) AS last_message_at,
       u.season_xp AS xp, u.level AS level, u.season_points AS points
     FROM users u
     LEFT JOIN discord_message_events e
       ON e.author_discord_user_id = u.discord_user_id AND e.guild_id = ?${windowClause}
     WHERE u.guild_id = ? AND u.season_key = ?
     GROUP BY u.discord_user_id, u.username, u.display_name, u.avatar,
       u.season_message_count, u.season_xp, u.level, u.season_points
     ORDER BY message_count DESC, u.season_xp DESC, u.display_name ASC
     LIMIT 100`,
    period === 'all_time' || period === 'this_month'
      ? [guildId, guildId, seasonKey]
      : params
  );
}

module.exports = { getDiscordLeaderboard, recordGuildMessage };