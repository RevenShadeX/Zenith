'use strict';

const BADGES = [
  { id: 'first_steps', name: 'First Steps', description: 'Send your first Discord message.', rarity: 'common', icon: '01' },
  { id: 'regular', name: 'Regular', description: 'Send 100 tracked Discord messages.', rarity: 'common', icon: '02' },
  { id: 'active_member', name: 'Active Member', description: 'Send 1,000 tracked Discord messages.', rarity: 'uncommon', icon: '03' },
  { id: 'community_pillar', name: 'Community Pillar', description: 'Send 5,000 tracked Discord messages.', rarity: 'rare', icon: '04' },
  { id: 'daily_grinder', name: 'Daily Grinder', description: 'Complete 7 daily missions.', rarity: 'uncommon', icon: '05' },
  { id: 'dedicated', name: 'Dedicated', description: 'Complete 30 daily missions.', rarity: 'rare', icon: '06' },
  { id: 'weekly_warrior', name: 'Weekly Warrior', description: 'Complete 4 weekly missions.', rarity: 'rare', icon: '07' },
  { id: 'night_owl', name: 'Night Owl', description: 'Take part in 10 watch parties.', rarity: 'uncommon', icon: '08' },
  { id: 'movie_buff', name: 'Movie Buff', description: 'Take part in 25 watch parties.', rarity: 'rare', icon: '09' },
  { id: 'event_regular', name: 'Event Regular', description: 'Join 10 community events.', rarity: 'uncommon', icon: '10' },
  { id: 'game_on', name: 'Game On', description: 'Win your first daily word game.', rarity: 'common', icon: '11' },
  { id: 'puzzle_master', name: 'Puzzle Master', description: 'Win 25 daily word games.', rarity: 'rare', icon: '12' },
  { id: 'streak_keeper', name: 'Streak Keeper', description: 'Reach a 7-day daily-game streak.', rarity: 'uncommon', icon: '13' },
  { id: 'unstoppable', name: 'Unstoppable', description: 'Reach a 30-day daily-game streak.', rarity: 'epic', icon: '14' },
  { id: 'early_supporter', name: 'Early Supporter', description: 'Be among the first 25 Zenith members.', rarity: 'epic', icon: '15' },
  { id: 'veteran', name: 'Veteran', description: 'Be a Zenith member for 6 months.', rarity: 'legendary', icon: '16' },
  { id: 'study_starter', name: 'Study Starter', description: 'Spend 1 hour in the study VC.', rarity: 'common', icon: '17' },
  { id: 'study_scholar', name: 'Study Scholar', description: 'Spend 10 hours in the study VC.', rarity: 'uncommon', icon: '18' },
  { id: 'study_machine', name: 'Study Machine', description: 'Spend 50 hours in the study VC.', rarity: 'epic', icon: '19' },
];

const BADGE_BY_ID = new Map(BADGES.map((badge) => [badge.id, badge]));
const DAY = 24 * 60 * 60 * 1000;

async function getCounts(database, discordUserId) {
  const user = await database.get('SELECT * FROM users WHERE discord_user_id = ?', [discordUserId]);
  if (!user) return null;

  const [daily, weekly, events, study] = await Promise.all([
    database.get("SELECT COUNT(*) AS count FROM mission_claims WHERE discord_user_id = ? AND mission_id LIKE 'daily_%'", [discordUserId]),
    database.get("SELECT COUNT(*) AS count FROM mission_claims WHERE discord_user_id = ? AND mission_id LIKE 'weekly_%'", [discordUserId]),
    database.get('SELECT COUNT(*) AS count FROM event_participants WHERE discord_user_id = ?', [discordUserId]),
    database.get('SELECT seconds FROM study_vc_time WHERE discord_user_id = ?', [discordUserId]),
  ]);

  const memberRank = await database.get(
    'SELECT COUNT(*) AS rank FROM users WHERE created_at < (SELECT created_at FROM users WHERE discord_user_id = ?)',
    [discordUserId]
  );

  return {
    messages: Number(user.tracked_message_count || 0),
    dailyMissions: Number(daily?.count || 0),
    weeklyMissions: Number(weekly?.count || 0),
    movieNights: Number(user.movie_nights || 0),
    events: Number(events?.count || 0),
    games: Number(user.game_wins || 0),
    streak: Number(user.current_streak || 0),
    studySeconds: Number(study?.seconds || 0),
    memberRank: Number(memberRank?.rank || 0) + 1,
    createdAt: new Date(user.created_at || Date.now()).getTime(),
  };
}

function unlockedByCriteria(badge, counts) {
  if (badge.id === 'first_steps') return counts.messages >= 1;
  if (badge.id === 'regular') return counts.messages >= 100;
  if (badge.id === 'active_member') return counts.messages >= 1000;
  if (badge.id === 'community_pillar') return counts.messages >= 5000;
  if (badge.id === 'daily_grinder') return counts.dailyMissions >= 7;
  if (badge.id === 'dedicated') return counts.dailyMissions >= 30;
  if (badge.id === 'weekly_warrior') return counts.weeklyMissions >= 4;
  if (badge.id === 'night_owl') return counts.movieNights >= 10;
  if (badge.id === 'movie_buff') return counts.movieNights >= 25;
  if (badge.id === 'event_regular') return counts.events >= 10;
  if (badge.id === 'game_on') return counts.games >= 1;
  if (badge.id === 'puzzle_master') return counts.games >= 25;
  if (badge.id === 'streak_keeper') return counts.streak >= 7;
  if (badge.id === 'unstoppable') return counts.streak >= 30;
  if (badge.id === 'early_supporter') return counts.memberRank <= 25;
  if (badge.id === 'veteran') return Date.now() - counts.createdAt >= 180 * DAY;
  if (badge.id === 'study_starter') return counts.studySeconds >= 60 * 60;
  if (badge.id === 'study_scholar') return counts.studySeconds >= 10 * 60 * 60;
  if (badge.id === 'study_machine') return counts.studySeconds >= 50 * 60 * 60;
  return false;
}

async function checkAndUnlockBadges(database, discordUserId) {
  const counts = await getCounts(database, discordUserId);
  if (!counts) return [];

  for (const badge of BADGES) {
    if (!unlockedByCriteria(badge, counts)) continue;
    await database.run(
      'INSERT OR IGNORE INTO user_badges (badge_id, discord_user_id, unlocked_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [badge.id, discordUserId]
    );
  }

  return getUserBadges(database, discordUserId);
}

async function getUserBadges(database, discordUserId) {
  const rows = await database.all(
    'SELECT badge_id, unlocked_at FROM user_badges WHERE discord_user_id = ? ORDER BY unlocked_at ASC, badge_id ASC',
    [discordUserId]
  );
  return rows.map((row) => ({
    ...(BADGE_BY_ID.get(row.badge_id) || { id: row.badge_id, name: row.badge_id, description: '', rarity: 'common', icon: '?' }),
    unlockedAt: row.unlocked_at,
  }));
}

async function getBadgesForUsers(database, userIds) {
  const uniqueIds = [...new Set(userIds.filter(Boolean).map(String))];
  if (!uniqueIds.length) return new Map();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await database.all(
    `SELECT badge_id, discord_user_id, unlocked_at
     FROM user_badges
     WHERE discord_user_id IN (${placeholders})
     ORDER BY unlocked_at ASC`,
    uniqueIds
  );
  const map = new Map(uniqueIds.map((id) => [id, []]));
  for (const row of rows) {
    const badge = BADGE_BY_ID.get(row.badge_id);
    if (badge) map.get(String(row.discord_user_id)).push({ ...badge, unlockedAt: row.unlocked_at });
  }
  return map;
}

module.exports = { BADGES, checkAndUnlockBadges, getBadgesForUsers, getUserBadges };
