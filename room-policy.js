'use strict';

function isRoomHost(room, discordUserId) {
  return Boolean(room && discordUserId && room.host_user_id === discordUserId);
}

function canJoinRoom(room, discordUserId, isMember) {
  if (!room || room.status !== 'live' || !discordUserId) return false;
  if (!room.locked || isRoomHost(room, discordUserId)) return true;
  return Boolean(isMember);
}

module.exports = { canJoinRoom, isRoomHost };