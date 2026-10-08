'use strict';

function getTimeZone() {
  return process.env.ZENITH_TIMEZONE || 'Asia/Colombo';
}

function getSeasonKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getTimeZone(),
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return values.year + '-' + values.month;
}

async function ensureUserSeason(database, discordUserId, now = new Date()) {
  const id = String(discordUserId);
  const seasonKey = getSeasonKey(now);
  const user = await database.get(
    'SELECT discord_user_id, season_key, xp, points, tracked_message_count, level FROM users WHERE discord_user_id = ?',
    [id]
  );
  if (!user) return seasonKey;
  if (user.season_key === seasonKey) return seasonKey;

  if (user.season_key) {
    const study = await database.get(
      'SELECT seconds FROM season_study_vc_time WHERE discord_user_id = ? AND season_key = ?',
      [id, user.season_key]
    );
    const badges = await database.get(
      'SELECT COUNT(*) AS count FROM season_badges WHERE discord_user_id = ? AND season_key = ?',
      [id, user.season_key]
    );
    await database.run(
      `INSERT INTO season_history
        (discord_user_id, season_key, xp, points, messages, level, study_seconds, badge_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(discord_user_id, season_key) DO NOTHING`,
      [
        id,
        user.season_key,
        Number(user.xp || 0),
        Number(user.points || 0),
        Number(user.tracked_message_count || 0),
        Number(user.level || 1),
        Number(study?.seconds || 0),
        Number(badges?.count || 0),
      ]
    );
  }

  await database.run(
    `UPDATE users
     SET season_key = ?, season_xp = 0, season_points = 0,
         season_message_count = 0, level = 1, last_xp_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE discord_user_id = ?`,
    [seasonKey, id]
  );
  return seasonKey;
}

async function ensureUsersCurrentSeason(database, guildId, now = new Date()) {
  const users = await database.all(
    'SELECT discord_user_id FROM users WHERE guild_id = ? AND (season_key IS NULL OR season_key <> ?)',
    [guildId, getSeasonKey(now)]
  );
  for (const user of users) await ensureUserSeason(database, user.discord_user_id, now);
  return getSeasonKey(now);
}

module.exports = { getSeasonKey, ensureUserSeason, ensureUsersCurrentSeason };
