'use strict';

const { getSeasonKey, ensureUserSeason } = require('./season');

const BADGES = [
  { id: 'first_steps', name: 'First Steps', description: 'Send your first Discord message this month.', rarity: 'common', icon: '01' },
  { id: 'regular', name: 'Regular', description: 'Send 100 Discord messages this month.', rarity: 'common', icon: '02' },
  { id: 'active_member', name: 'Active Member', description: 'Send 500 Discord messages this month.', rarity: 'uncommon', icon: '03' },
  { id: 'community_pillar', name: 'Community Pillar', description: 'Send 2,000 Discord messages this month.', rarity: 'rare', icon: '04' },
  { id: 'daily_grinder', name: 'Daily Grinder', description: 'Complete 7 daily missions this month.', rarity: 'uncommon', icon: '05' },
  { id: 'dedicated', name: 'Dedicated', description: 'Complete 20 daily missions this month.', rarity: 'rare', icon: '06' },
  { id: 'weekly_warrior', name: 'Weekly Warrior', description: 'Complete 4 weekly missions this month.', rarity: 'rare', icon: '07' },
  { id: 'night_owl', name: 'Night Owl', description: 'Join 5 watch parties this month.', rarity: 'uncommon', icon: '08' },
  { id: 'movie_buff', name: 'Movie Buff', description: 'Join 15 watch parties this month.', rarity: 'rare', icon: '09' },
  { id: 'event_regular', name: 'Event Regular', description: 'Join 5 community events this month.', rarity: 'uncommon', icon: '10' },
  { id: 'game_on', name: 'Game On', description: 'Solve a daily word game this month.', rarity: 'common', icon: '11' },
  { id: 'puzzle_master', name: 'Puzzle Master', description: 'Solve 10 daily word games this month.', rarity: 'rare', icon: '12' },
  { id: 'study_starter', name: 'Study Starter', description: 'Spend 1 hour in the study VC this month.', rarity: 'common', icon: '13' },
  { id: 'study_scholar', name: 'Study Scholar', description: 'Spend 10 hours in the study VC this month.', rarity: 'uncommon', icon: '14' },
  { id: 'study_machine', name: 'Study Machine', description: 'Spend 30 hours in the study VC this month.', rarity: 'epic', icon: '15' },
  { id: 'xp_hunter', name: 'XP Hunter', description: 'Earn 1,000 XP this month.', rarity: 'rare', icon: '16' },
  { id: 'season_legend', name: 'Season Legend', description: 'Earn 5,000 XP this month.', rarity: 'legendary', icon: '17' },
  { id: 'invite_streak_7', name: 'Community Builder', description: 'Invite at least 1 new member for 7 consecutive days.', rarity: 'epic', icon: '18', permanent: true },
];

const BADGE_BY_ID = new Map(BADGES.map((badge) => [badge.id, badge]));

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zonedMidnight(date, timeZone) {
  const parts = localDateParts(date, timeZone);
  const candidate = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const displayed = localDateParts(new Date(candidate), timeZone);
  const displayedAsUtc = Date.UTC(displayed.year, displayed.month - 1, displayed.day, 0, 0, 0);
  return new Date(candidate - (displayedAsUtc - candidate));
}

function localDateKey(date, timeZone = process.env.ZENITH_TIMEZONE || 'Asia/Colombo') {
  const parts = localDateParts(date, timeZone);
  return [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')].join('-');
}

function previousDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1, 12, 0, 0));
  return localDateKey(previous);
}

async function getInviteStreak(database, discordUserId, now = new Date()) {
  const rows = await database.all(
    'SELECT joined_at FROM discord_invite_uses WHERE inviter_discord_user_id = ? ORDER BY joined_at DESC',
    [discordUserId]
  );
  const timeZone = process.env.ZENITH_TIMEZONE || 'Asia/Colombo';
  const inviteDates = new Set(rows.map((row) => localDateKey(new Date(row.joined_at), timeZone)));
  let cursor = localDateKey(now, timeZone);
  let streak = 0;
  while (inviteDates.has(cursor)) {
    streak += 1;
    cursor = previousDateKey(cursor);
  }
  return streak;
}

function seasonBounds(now = new Date()) {
  const timeZone = process.env.ZENITH_TIMEZONE || 'Asia/Colombo';
  const parts = localDateParts(now, timeZone);
  const start = zonedMidnight(new Date(Date.UTC(parts.year, parts.month - 1, 1, 12, 0, 0)), timeZone);
  const end = parts.month === 12
    ? zonedMidnight(new Date(Date.UTC(parts.year + 1, 0, 1, 12, 0, 0)), timeZone)
    : zonedMidnight(new Date(Date.UTC(parts.year, parts.month, 1, 12, 0, 0)), timeZone);
  return { start: start.toISOString(), end: end.toISOString(), key: getSeasonKey(now) };
}

async function getCounts(database, discordUserId, now = new Date()) {
  await ensureUserSeason(database, discordUserId, now);
  const user = await database.get('SELECT * FROM users WHERE discord_user_id = ?', [discordUserId]);
  if (!user) return null;
  const bounds = seasonBounds(now);

  const [daily, weekly, events, games, watchParties, study, inviteStreak] = await Promise.all([
    database.get('SELECT COUNT(*) AS count FROM mission_claims WHERE discord_user_id = ? AND mission_id LIKE ? AND period_key LIKE ?', [discordUserId, 'daily_%', bounds.key + '-%']),
    database.get('SELECT COUNT(*) AS count FROM mission_claims WHERE discord_user_id = ? AND mission_id LIKE ? AND period_key LIKE ?', [discordUserId, 'weekly_%', bounds.key + '-%']),
    database.get('SELECT COUNT(*) AS count FROM event_participants WHERE discord_user_id = ? AND joined_at >= ? AND joined_at < ?', [discordUserId, bounds.start, bounds.end]),
    database.get('SELECT COUNT(*) AS count FROM daily_game_attempts WHERE discord_user_id = ? AND solved = ? AND date_key LIKE ?', [discordUserId, true, bounds.key + '-%']),
    database.get('SELECT COUNT(DISTINCT room_id) AS count FROM room_members WHERE discord_user_id = ? AND joined_at >= ? AND joined_at < ?', [discordUserId, bounds.start, bounds.end]),
    database.get('SELECT seconds FROM season_study_vc_time WHERE discord_user_id = ? AND season_key = ?', [discordUserId, bounds.key]),
    getInviteStreak(database, discordUserId, now),
  ]);

  return {
    messages: Number(user.season_message_count || 0),
    xp: Number(user.season_xp || 0),
    dailyMissions: Number(daily?.count || 0),
    weeklyMissions: Number(weekly?.count || 0),
    events: Number(events?.count || 0),
    games: Number(games?.count || 0),
    watchParties: Number(watchParties?.count || 0),
    studySeconds: Number(study?.seconds || 0),
    inviteStreak: Number(inviteStreak || 0),
  };
}

function unlockedByCriteria(badge, counts) {
  if (badge.id === 'first_steps') return counts.messages >= 1;
  if (badge.id === 'regular') return counts.messages >= 100;
  if (badge.id === 'active_member') return counts.messages >= 500;
  if (badge.id === 'community_pillar') return counts.messages >= 2000;
  if (badge.id === 'daily_grinder') return counts.dailyMissions >= 7;
  if (badge.id === 'dedicated') return counts.dailyMissions >= 20;
  if (badge.id === 'weekly_warrior') return counts.weeklyMissions >= 4;
  if (badge.id === 'night_owl') return counts.watchParties >= 5;
  if (badge.id === 'movie_buff') return counts.watchParties >= 15;
  if (badge.id === 'event_regular') return counts.events >= 5;
  if (badge.id === 'game_on') return counts.games >= 1;
  if (badge.id === 'puzzle_master') return counts.games >= 10;
  if (badge.id === 'study_starter') return counts.studySeconds >= 60 * 60;
  if (badge.id === 'study_scholar') return counts.studySeconds >= 10 * 60 * 60;
  if (badge.id === 'study_machine') return counts.studySeconds >= 30 * 60 * 60;
  if (badge.id === 'xp_hunter') return counts.xp >= 1000;
  if (badge.id === 'season_legend') return counts.xp >= 5000;
  if (badge.id === 'invite_streak_7') return counts.inviteStreak >= 7;
  return false;
}

async function checkAndUnlockBadges(database, discordUserId, now = new Date()) {
  const counts = await getCounts(database, discordUserId, now);
  if (!counts) return [];
  const seasonKey = getSeasonKey(now);

  for (const badge of BADGES) {
    if (!unlockedByCriteria(badge, counts)) continue;
    await database.run(
      'INSERT OR IGNORE INTO season_badges (badge_id, discord_user_id, season_key, unlocked_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [badge.id, discordUserId, seasonKey]
    );
  }

  return getUserBadges(database, discordUserId, now);
}

async function getUserBadges(database, discordUserId, now = new Date()) {
  const seasonKey = getSeasonKey(now);
  const rows = await database.all(
    'SELECT badge_id, unlocked_at FROM season_badges WHERE discord_user_id = ? AND season_key = ? UNION ALL SELECT badge_id, unlocked_at FROM user_badges WHERE discord_user_id = ? ORDER BY unlocked_at ASC, badge_id ASC',
    [discordUserId, seasonKey, discordUserId]
  );
  return rows.map((row) => ({
    ...(BADGE_BY_ID.get(row.badge_id) || { id: row.badge_id, name: row.badge_id, description: '', rarity: 'common', icon: '?' }),
    unlockedAt: row.unlocked_at,
  }));
}

async function getBadgesForUsers(database, userIds, now = new Date()) {
  const uniqueIds = [...new Set(userIds.filter(Boolean).map(String))];
  if (!uniqueIds.length) return new Map();
  const seasonKey = getSeasonKey(now);
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await database.all(
    `SELECT badge_id, discord_user_id, unlocked_at
     FROM season_badges
     WHERE season_key = ? AND discord_user_id IN (${placeholders})
     UNION ALL
     SELECT badge_id, discord_user_id, unlocked_at
     FROM user_badges
     WHERE discord_user_id IN (${placeholders})
     ORDER BY unlocked_at ASC`,
    [seasonKey, ...uniqueIds, ...uniqueIds]
  );
  const map = new Map(uniqueIds.map((id) => [id, []]));
  for (const row of rows) {
    const badge = BADGE_BY_ID.get(row.badge_id);
    if (badge) map.get(String(row.discord_user_id)).push({ ...badge, unlockedAt: row.unlocked_at });
  }
  return map;
}

module.exports = { BADGES, checkAndUnlockBadges, getBadgesForUsers, getUserBadges };
