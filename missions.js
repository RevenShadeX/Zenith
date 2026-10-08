'use strict';

const { ensureUserSeason } = require('./season');

const DAILY_MISSIONS = [
  { id: 'daily_messages_10', period: 'daily', title: 'Say hello', description: 'Send 10 messages in the Discord server.', target: 10, metric: 'messages', xp: 50, points: 25 },
  { id: 'daily_game_1', period: 'daily', title: 'Solve today\'s puzzle', description: 'Complete the Zenith daily word game.', target: 1, metric: 'game_wins', xp: 50, points: 25 },
  { id: 'daily_event_1', period: 'daily', title: 'Show up', description: 'Join a community event today.', target: 1, metric: 'event_joins', xp: 50, points: 25 },
  { id: 'daily_invites_1', period: 'daily', title: 'Bring a friend', description: 'Invite 1 new member to the Discord server.', target: 1, metric: 'invites', xp: 75, points: 35 },
];

const WEEKLY_MISSIONS = [
  { id: 'weekly_messages_100', period: 'weekly', title: 'Keep the server alive', description: 'Send 100 messages this week.', target: 100, metric: 'messages', xp: 200, points: 100 },
  { id: 'weekly_games_3', period: 'weekly', title: 'Puzzle regular', description: 'Solve 3 daily word games this week.', target: 3, metric: 'game_wins', xp: 250, points: 100 },
  { id: 'weekly_events_2', period: 'weekly', title: 'Be there', description: 'Join 2 community events this week.', target: 2, metric: 'event_joins', xp: 200, points: 100 },
  { id: 'weekly_invites_3', period: 'weekly', title: 'Grow the crew', description: 'Invite 3 new members to the Discord server this week.', target: 3, metric: 'invites', xp: 300, points: 150 },
];

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function localDateKey(date, timeZone) {
  const parts = localDateParts(date, timeZone);
  return [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')].join('-');
}

function zonedMidnight(date, timeZone) {
  const parts = localDateParts(date, timeZone);
  const candidate = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const displayed = localDateParts(new Date(candidate), timeZone);
  const displayedAsUtc = Date.UTC(displayed.year, displayed.month - 1, displayed.day, 0, 0, 0);
  return new Date(candidate - (displayedAsUtc - candidate));
}

function addLocalDays(date, days, timeZone) {
  const parts = localDateParts(date, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return zonedMidnight(shifted, timeZone);
}

function periodBounds(period, now = new Date(), timeZone = process.env.ZENITH_TIMEZONE || 'Asia/Colombo') {
  const dayStart = zonedMidnight(now, timeZone);
  if (period === 'daily') {
    return {
      key: localDateKey(now, timeZone),
      start: dayStart,
      end: addLocalDays(now, 1, timeZone),
    };
  }
  const local = localDateParts(now, timeZone);
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const weekStart = addLocalDays(now, -daysSinceMonday, timeZone);
  const weekParts = localDateParts(weekStart, timeZone);
  const key = [weekParts.year, String(weekParts.month).padStart(2, '0'), String(weekParts.day).padStart(2, '0')].join('-');
  return { key, start: weekStart, end: addLocalDays(weekStart, 7, timeZone) };
}

async function getMetricProgress(database, userId, mission, now = new Date()) {
  const bounds = periodBounds(mission.period, now);
  const start = bounds.start.toISOString();
  const end = bounds.end.toISOString();

  if (mission.metric === 'messages') {
    const row = await database.get(
      'SELECT COUNT(*) AS count FROM discord_message_events WHERE author_discord_user_id = ? AND created_at >= ? AND created_at < ?',
      [userId, start, end]
    );
    return Number(row?.count || 0);
  }

  if (mission.metric === 'game_wins') {
    const row = await database.get(
      'SELECT COUNT(*) AS count FROM daily_game_attempts WHERE discord_user_id = ? AND solved = ? AND date_key >= ? AND date_key < ?',
      [userId, true, bounds.key, localDateKey(bounds.end, process.env.ZENITH_TIMEZONE || 'Asia/Colombo')]
    );
    return Number(row?.count || 0);
  }

  if (mission.metric === 'invites') {
    const row = await database.get(
      'SELECT COUNT(*) AS count FROM discord_invite_uses WHERE inviter_discord_user_id = ? AND joined_at >= ? AND joined_at < ?',
      [userId, start, end]
    );
    return Number(row?.count || 0);
  }

  if (mission.metric === 'event_joins') {
    const query = database.isPostgres
      ? 'SELECT COUNT(*) AS count FROM event_participants WHERE discord_user_id = ? AND joined_at >= ? AND joined_at < ?'
      : 'SELECT COUNT(*) AS count FROM event_participants WHERE discord_user_id = ? AND datetime(joined_at) >= datetime(?) AND datetime(joined_at) < datetime(?)';
    const row = await database.get(query, [userId, start, end]);
    return Number(row?.count || 0);
  }

  return 0;
}

async function getCommunityMissionState(database, now = new Date(), guildId = process.env.DISCORD_GUILD_ID || 'unconfigured', currentUserId = '') {
  const users = await database.all(
    'SELECT discord_user_id, username, display_name, avatar FROM users WHERE guild_id = ? OR discord_user_id = ? ORDER BY display_name ASC',
    [guildId, currentUserId]
  );
  const missions = [...DAILY_MISSIONS, ...WEEKLY_MISSIONS];
  const claims = users.length
    ? await database.all(
      'SELECT mission_id, discord_user_id, period_key FROM mission_claims WHERE discord_user_id IN (' + users.map(() => '?').join(',') + ')',
      users.map((user) => user.discord_user_id)
    )
    : [];
  const claimed = new Set(claims.map((claim) => missionClaimKey(claim.mission_id, claim.discord_user_id, claim.period_key)));

  const memberStates = await Promise.all(users.map(async (user) => {
    await ensureUserSeason(database, user.discord_user_id, now);
    const missionsForUser = {};
    for (const mission of missions) {
      const bounds = periodBounds(mission.period, now);
      const progress = Math.min(mission.target, await getMetricProgress(database, user.discord_user_id, mission, now));
      missionsForUser[mission.id] = {
        progress,
        completed: progress >= mission.target,
        claimed: claimed.has(missionClaimKey(mission.id, user.discord_user_id, bounds.key)),
      };
    }
    return {
      id: user.discord_user_id,
      username: user.username,
      displayName: user.display_name || user.username,
      avatar: user.avatar || '',
      missions: missionsForUser,
    };
  }));

  return {
    timezone: process.env.ZENITH_TIMEZONE || 'Asia/Colombo',
    daily: DAILY_MISSIONS.map((mission) => {
      const bounds = periodBounds(mission.period, now);
      return {
        ...mission,
        periodKey: bounds.key,
        members: memberStates.map((member) => ({
          id: member.id,
          username: member.username,
          displayName: member.displayName,
          avatar: member.avatar,
          ...member.missions[mission.id],
        })),
      };
    }),
    weekly: WEEKLY_MISSIONS.map((mission) => {
      const bounds = periodBounds(mission.period, now);
      return {
        ...mission,
        periodKey: bounds.key,
        members: memberStates.map((member) => ({
          id: member.id,
          username: member.username,
          displayName: member.displayName,
          avatar: member.avatar,
          ...member.missions[mission.id],
        })),
      };
    }),
  };
}

async function getMissionState(database, userId, now = new Date()) {
  await ensureUserSeason(database, userId, now);
  const missions = [...DAILY_MISSIONS, ...WEEKLY_MISSIONS];
  const claims = await database.all(
    'SELECT mission_id, period_key FROM mission_claims WHERE discord_user_id = ?',
    [userId]
  );
  const claimed = new Set(claims.map((claim) => missionClaimKey(claim.mission_id, userId, claim.period_key)));
  const result = [];

  for (const mission of missions) {
    const bounds = periodBounds(mission.period, now);
    const progress = Math.min(mission.target, await getMetricProgress(database, userId, mission, now));
    result.push({
      ...mission,
      periodKey: bounds.key,
      progress,
      completed: progress >= mission.target,
      claimed: claimed.has(missionClaimKey(mission.id, userId, bounds.key)),
    });
  }

  return {
    timezone: process.env.ZENITH_TIMEZONE || 'Asia/Colombo',
    daily: result.filter((mission) => mission.period === 'daily'),
    weekly: result.filter((mission) => mission.period === 'weekly'),
  };
}

function missionClaimKey(missionId, userId, periodKey) {
  return missionId + ':' + String(userId || '') + ':' + periodKey;
}

async function claimMission(database, userId, missionId, periodKey) {
  const mission = [...DAILY_MISSIONS, ...WEEKLY_MISSIONS].find((entry) => entry.id === missionId);
  if (!mission) throw new Error('Mission not found.');

  const bounds = periodBounds(mission.period);
  if (periodKey !== bounds.key) throw new Error('That mission has expired. Refresh the page.');

  const progress = await getMetricProgress(database, userId, mission);
  if (progress < mission.target) throw new Error('Complete the mission before claiming its reward.');

  await ensureUserSeason(database, userId);

  const inserted = await database.run(
    'INSERT OR IGNORE INTO mission_claims (mission_id, discord_user_id, period_key, xp_reward, points_reward) VALUES (?, ?, ?, ?, ?)',
    [mission.id, userId, periodKey, mission.xp, mission.points]
  );
  if (!inserted.changes) throw new Error('This mission reward has already been claimed.');

  const user = await database.get('SELECT xp, season_xp FROM users WHERE discord_user_id = ?', [userId]);
  const newXp = Number(user?.xp || 0) + mission.xp;
  const newSeasonXp = Number(user?.season_xp || 0) + mission.xp;
  const newLevel = Math.floor(Math.sqrt(newSeasonXp / 120)) + 1;
  await database.run(
    'UPDATE users SET xp = ?, season_xp = ?, level = ?, points = points + ?, season_points = season_points + ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?',
    [newXp, newSeasonXp, newLevel, mission.points, mission.points, userId]
  );

  return { mission, xp: newXp, level: newLevel, points: mission.points };
}

module.exports = { DAILY_MISSIONS, WEEKLY_MISSIONS, claimMission, getMissionState, getCommunityMissionState };
