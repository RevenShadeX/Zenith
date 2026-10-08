'use strict';

const STUDY_VC_SETTING = 'study_vc_channel_id';

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

async function getStudyVcChannelId(database) {
  const setting = await database.get('SELECT setting_value FROM app_settings WHERE setting_key = ?', [STUDY_VC_SETTING]);
  return setting?.setting_value || '';
}

async function setStudyVcChannelId(database, channelId) {
  await database.run(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`,
    [STUDY_VC_SETTING, String(channelId || '')]
  );
}

async function startStudySession(database, discordUserId, channelId) {
  if (!discordUserId || !channelId) return false;
  const existing = await database.get('SELECT discord_user_id FROM study_vc_sessions WHERE discord_user_id = ?', [discordUserId]);
  if (existing) return false;
  await database.run(
    'INSERT OR IGNORE INTO study_vc_sessions (discord_user_id, channel_id, joined_at) VALUES (?, ?, ?)',
    [String(discordUserId), String(channelId), new Date().toISOString()]
  );
  return true;
}

async function stopStudySession(database, discordUserId, now = Date.now()) {
  const session = await database.get('SELECT discord_user_id, joined_at FROM study_vc_sessions WHERE discord_user_id = ?', [String(discordUserId)]);
  if (!session) return 0;
  const joinedAt = new Date(session.joined_at).getTime();
  const seconds = Number.isFinite(joinedAt) ? Math.max(0, Math.floor((now - joinedAt) / 1000)) : 0;
  await database.run(
    `INSERT INTO study_vc_time (discord_user_id, seconds)
     VALUES (?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET seconds = study_vc_time.seconds + excluded.seconds`,
    [String(discordUserId), seconds]
  );
  await database.run('DELETE FROM study_vc_sessions WHERE discord_user_id = ?', [String(discordUserId)]);
  return seconds;
}

async function flushStudySessions(database, now = Date.now()) {
  const sessions = await database.all('SELECT discord_user_id, joined_at FROM study_vc_sessions');
  for (const session of sessions) {
    const joinedAt = new Date(session.joined_at).getTime();
    const seconds = Number.isFinite(joinedAt) ? Math.max(0, Math.floor((now - joinedAt) / 1000)) : 0;
    if (seconds <= 0) continue;
    await database.run(
      `INSERT INTO study_vc_time (discord_user_id, seconds)
       VALUES (?, ?)
       ON CONFLICT(discord_user_id) DO UPDATE SET seconds = study_vc_time.seconds + excluded.seconds`,
      [String(session.discord_user_id), seconds]
    );
    await database.run('UPDATE study_vc_sessions SET joined_at = ? WHERE discord_user_id = ?', [new Date(now).toISOString(), String(session.discord_user_id)]);
  }
}

async function getStudyLeaderboard(database, guildId, now = Date.now()) {
  await flushStudySessions(database, now);
  const rows = await database.all(
    `SELECT u.discord_user_id AS id, u.username, u.display_name, u.avatar,
       COALESCE(t.seconds, 0) AS seconds
     FROM study_vc_time t
     INNER JOIN users u ON u.discord_user_id = t.discord_user_id
     WHERE u.guild_id = ?
     ORDER BY seconds DESC, u.display_name ASC
     LIMIT 100`,
    [guildId]
  );
  return rows.map((row) => ({
    ...row,
    seconds: Number(row.seconds || 0),
    duration: formatDuration(row.seconds),
  }));
}

module.exports = {
  formatDuration,
  getStudyLeaderboard,
  getStudyVcChannelId,
  setStudyVcChannelId,
  startStudySession,
  stopStudySession,
  flushStudySessions,
};
