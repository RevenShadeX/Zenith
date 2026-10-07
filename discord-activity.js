'use strict';

const { isTrackableMessage } = require('./discord-bot');
const { leaderboardWindowStart } = require('./leaderboard');

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
     points = points + 1,
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
      'SELECT xp FROM users WHERE discord_user_id = ?',
      [discordUserId]
    );
    const newXp = Number(userState?.xp || 0) + 15;
    const newLevel = Math.floor(Math.sqrt(newXp / 100)) + 1;
    await database.run(
      'UPDATE users SET xp = ?, level = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?',
      [newXp, newLevel, discordUserId]
    );
  }
  return true;
}

async function getDiscordLeaderboard(database, guildId, period = 'all_time', now = new Date()) {
  const start = leaderboardWindowStart(period, now);
  const params = [guildId];
  let windowClause = '';
  if (start) {
    windowClause = ' AND e.created_at >= ?';
    params.push(start);
  }
  return database.all(
    `SELECT u.discord_user_id AS id, u.username, u.display_name, u.avatar,
       COUNT(e.message_id) AS message_count, MAX(e.created_at) AS last_message_at,
       MAX(u.xp) AS xp, MAX(u.level) AS level, MAX(u.points) AS points
     FROM discord_message_events e
     INNER JOIN users u ON u.discord_user_id = e.author_discord_user_id
     WHERE e.guild_id = ?${windowClause}
     GROUP BY u.discord_user_id, u.username, u.display_name, u.avatar
     ORDER BY message_count DESC, u.display_name ASC
     LIMIT 100`,
    params
  );
}

module.exports = { getDiscordLeaderboard, recordGuildMessage };