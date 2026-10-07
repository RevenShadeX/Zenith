'use strict';

function leaderboardWindowStart(period, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (period === 'all_time') return null;
  if (period === 'today') return start.toISOString();
  if (period === 'this_week') {
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
    return start.toISOString();
  }
  if (period === 'this_month') {
    start.setUTCDate(1);
    return start.toISOString();
  }

  throw new Error('Period must be today, this_week, this_month, or all_time.');
}

module.exports = { leaderboardWindowStart };