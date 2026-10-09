const pages = ['home', 'rooms', 'watch', 'room-ended', 'community', 'games', 'events', 'status'];
const state = {
  user: null,
  rooms: [],
  events: [],
  leaderboard: [],
  studyLeaderboard: [],
  studyChannelId: '',
  tracking: null,
  memberCount: null,
  leaderboardPeriod: 'this_month',
  latestMessages: [],
  messages: [],
  status: null,
  game: { guesses: [], solved: false, answer: '' },
  joinedEvents: new Set(),
  page: 'home',
  roomId: null,
  endedRoom: null,
  socket: null,
  socketRoomId: null,
  connectingRoomId: null,
  socketConnectPromise: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  mediaProvider: null,
  activeUsers: [],
  missions: null,
  communityMissions: null,
  seasonHistory: [],
  studyRefreshTimer: null,
  liveRefreshTimer: null,
  roomRefreshTimer: null,
  roomJoinReadyForSocket: null,
  playbackSyncTimer: null,
};

const appEl = document.querySelector('#app');
const topbarEl = document.querySelector('#topbar');
const toastEl = document.querySelector('#toast');
let toastTimer;

function closeCurrentRoomConnection() {
  window.clearInterval(state.playbackSyncTimer);
  state.playbackSyncTimer = null;
  if (state.socket) {
    if (state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'leave_room' }));
    state.socket.close(1000, 'Navigation');
  }
  state.socket = null;
  state.socketRoomId = null;
  state.mediaProvider?.destroy();
  state.mediaProvider = null;
  window.clearTimeout(state.reconnectTimer);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Request failed. Please try again.');
  return payload;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, tone = 'info') {
  toastEl.textContent = message;
  toastEl.dataset.tone = tone;
  toastEl.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('is-visible'), 3200);
}

function signInPrompt(label, className = 'button button-outline') {
  if (state.status?.discordAuth !== 'Configured') {
    return '<span class="auth-unavailable" role="status">Discord sign-in is not configured on this server.</span>';
  }
  return `<a class="${className}" href="/auth/discord">${escapeHtml(label)}</a>`;
}

function startDiscordLogin() {
  if (state.status?.discordAuth === 'Configured') window.location.href = '/auth/discord';
  else showToast('Discord sign-in is not configured on this server.', 'error');
}

async function refreshLiveHome() {
  try {
    const home = await fetchJson('/api/home');
    const nextCount = Number(home.tracking?.memberCount);
    state.memberCount = Number.isFinite(nextCount) ? nextCount : null;
    state.status = home.status || state.status;
    const countEl = document.querySelector('#serverMemberCount');
    const valueEl = document.querySelector('#serverMemberCountValue');
    if (countEl && valueEl) {
      const hasCount = state.memberCount !== null;
      countEl.classList.toggle('is-hidden', !hasCount);
      valueEl.textContent = hasCount ? state.memberCount.toLocaleString() : '—';
    } else {
      renderTopbar();
    }
  } catch {
    // Keep the last known live data if a background refresh fails.
  }
}

async function refreshRooms() {
  try {
    const response = await fetchJson('/api/rooms');
    const rooms = response.rooms || [];
    const signature = (items) => JSON.stringify(items.map((room) => ({
      id: room.id, name: room.name, status: room.status, locked: room.locked,
      viewer_count: room.viewer_count, host_user_id: room.host_user_id,
    })));
    if (signature(rooms) === signature(state.rooms)) return;
    state.rooms = rooms;

    if (state.page === 'rooms') {
      const grid = document.querySelector('#roomGrid');
      if (grid) grid.innerHTML = rooms.length
        ? rooms.map(renderRoomCard).join('')
        : '<div class="empty-state">No rooms available. Create the first one.</div>';
      const count = document.querySelector('.room-count');
      if (count) count.innerHTML = '<span class="status-dot"></span>' + rooms.length + ' LIVE';
    } else if (state.page === 'home') {
      const grid = document.querySelector('.page-section .room-grid');
      if (grid) grid.innerHTML = rooms.length
        ? rooms.slice(0, 3).map(renderRoomCard).join('')
        : '<div class="empty-state">No rooms are live right now. Start one for your crew.</div>';
      const roomSummary = document.querySelector('.visual-caption strong');
      if (roomSummary) roomSummary.textContent = rooms.length + ' rooms are open';
    }
  } catch {
    // Keep the last known room list if a background refresh fails.
  }
}

async function refreshEvents() {
  try {
    const response = await fetchJson('/api/events');
    state.events = response.events || [];
    state.events.sort((left, right) => new Date(left.start_time) - new Date(right.start_time));
    if (state.page === 'events' || state.page === 'home') renderApp();
  } catch {
    // Keep the last known event list if a background refresh fails.
  }
}

function navigate(page, roomId = null) {
  const previousPage = state.page;
  const previousRoomId = state.roomId;
  state.page = pages.includes(page) ? page : 'home';
  if (roomId) state.roomId = roomId;
  if (previousPage === 'watch' && (state.page !== 'watch' || (roomId && roomId !== previousRoomId))) {
    closeCurrentRoomConnection();
  }
  const hash = ['watch', 'room-ended'].includes(state.page) && state.roomId
    ? `#${state.page}/${encodeURIComponent(state.roomId)}`
    : `#${state.page}`;
  if (window.location.hash !== hash) window.location.hash = hash;
  renderTopbar();
  renderApp();
  if (state.page === 'watch' && state.roomId && state.user) connectRoomSocket(state.roomId);
  if (state.page === 'community') { refreshLeaderboard(state.leaderboardPeriod); refreshCommunityMissions(); }
  if (state.page === 'events') refreshEvents();
}

function renderTopbar() {
  const memberCount = Number.isFinite(Number(state.memberCount)) ? Number(state.memberCount) : null;
  const userHtml = state.user
    ? `<button class="profile-control" type="button" data-page="community" aria-label="Open your community profile">
        <img class="avatar" src="${escapeHtml(state.user.avatar)}" alt="" />
        <span><strong>${escapeHtml(state.user.displayName || state.user.username)}</strong><small>LEVEL ${state.user.level || 1}</small></span>
      </button>
      <button class="button button-quiet logout-button" type="button" data-action="logout">Sign out</button>`
    : state.status?.discordAuth === 'Configured'
      ? '<a class="button button-primary login-button" href="/auth/discord">Login with Discord</a>'
      : '<span class="login-unavailable" role="status">Discord login unavailable</span>';

  topbarEl.innerHTML = `
    <a class="brand" href="#home" data-page="home" aria-label="Zenith home">
      <span class="brand-mark" aria-hidden="true"></span><span>ZENITH</span><span id="serverMemberCount" class="server-member-count${memberCount === null ? ' is-hidden' : ''}" title="Live Discord server member count"><span class="server-member-dot" aria-hidden="true"></span><span id="serverMemberCountValue">${memberCount === null ? '—' : escapeHtml(memberCount.toLocaleString())}</span> MEMBERS</span>
    </a>
    <button class="mobile-menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false" data-action="toggle-nav">
      <span></span><span></span><span></span>
    </button>
    <nav class="nav" aria-label="Main navigation">
      ${pages.filter((page) => page !== 'room-ended').map((page) => `<a href="#${page}" data-page="${page}" class="${state.page === page ? 'is-active' : ''}">${page}</a>`).join('')}
    </nav>
    <div class="topbar-account">${userHtml}</div>
  `;
}

function renderStatus(status) {
  const rows = [
    ['Website', status?.website || 'Operational'],
    ['API', status?.api || 'Operational'],
    ['WebSocket', status?.websocket || 'Operational'],
    ['Database', status?.database || 'Operational'],
    ['Discord Bot', status?.discordBot || 'Not connected'],
    ['Discord Auth', status?.discordAuth || 'Not configured'],
    ['Online Users', status?.onlineUsers ?? 0],
    ['Active Rooms', status?.activeRooms ?? state.rooms.length],
    ['API Latency', status?.apiLatency || '—'],
  ];
  return rows.map(([label, value]) => `
    <article class="status-item">
      <div class="status-label"><span class="status-dot"></span>${escapeHtml(label)}</div>
      <strong>${escapeHtml(String(value))}</strong>
    </article>
  `).join('');
}

function getHostLabel(room) {
  const host = state.leaderboard.find((user) => user.id === room.host_user_id);
  return room.host_display_name || host?.display_name || host?.username || room.host_user_id || 'Zenith member';
}

function renderMissions(compact = false) {
  if (!state.user || !state.missions) return '';
  const groups = [
    ['DAILY', state.missions.daily || []],
    ['WEEKLY', state.missions.weekly || []],
  ];
  const cards = groups.flatMap(([label, missions]) => missions.map((mission) => {
    const percent = Math.min(100, Math.round((mission.progress / mission.target) * 100));
    const action = mission.completed && !mission.claimed
      ? `<button class="button button-small button-primary" type="button" data-action="claim-mission" data-mission-id="${escapeHtml(mission.id)}" data-period-key="${escapeHtml(mission.periodKey)}">Claim +${Number(mission.xp).toLocaleString()} XP</button>`
      : mission.claimed
        ? '<span class="mission-claimed">CLAIMED</span>'
        : '';
    return `<article class="mission-card ${mission.claimed ? 'is-claimed' : ''}">
      <div class="mission-card-top"><span class="eyebrow">${label}</span><strong>${Number(mission.progress).toLocaleString()} / ${Number(mission.target).toLocaleString()}</strong></div>
      <h3>${escapeHtml(mission.title)}</h3>
      <p>${escapeHtml(mission.description)}</p>
      <div class="mission-progress"><span style="width:${percent}%"></span></div>
      <div class="mission-footer"><span>+${Number(mission.xp).toLocaleString()} XP · +${Number(mission.points).toLocaleString()} points</span>${action}</div>
    </article>`;
  })).join('');
  return `<section class="missions-section ${compact ? 'missions-compact' : ''}">
    <div class="section-header"><div><span class="eyebrow">KEEP THE COMMUNITY MOVING</span><h2>Daily & weekly missions</h2></div><span class="mission-reset">Daily resets each day · Weekly resets Monday</span></div>
    <div class="missions-grid">${cards}</div>
  </section>`;
}

async function refreshCommunityMissions() {
  if (!state.user) {
    state.communityMissions = null;
    return;
  }
  try {
    state.communityMissions = await fetchJson('/api/missions/community');
    if (state.page === 'community') renderApp();
  } catch {
    state.communityMissions = null;
  }
}

function renderCommunityMissions() {
  if (!state.communityMissions) return '';
  const groups = [['DAILY', state.communityMissions.daily || []], ['WEEKLY', state.communityMissions.weekly || []]];
  const cards = groups.flatMap(([label, missions]) => missions.map((mission) => {
    const members = mission.members || [];
    const rows = members.length ? members.map((member) => {
      const percent = Math.min(100, Math.round((Number(member.progress || 0) / Number(mission.target || 1)) * 100));
      const status = member.claimed ? '<span class="mission-member-status">CLAIMED</span>' : member.completed ? '<span class="mission-member-status is-complete">COMPLETE</span>' : `<span class="mission-member-progress">${Number(member.progress || 0).toLocaleString()} / ${Number(mission.target || 0).toLocaleString()}</span>`;
      return `<div class="mission-member"><img class="avatar mission-member-avatar" src="${escapeHtml(member.avatar || 'https://api.dicebear.com/7.x/adventurer/svg?seed=member')}" alt="" /><div class="mission-member-main"><div class="mission-member-head"><strong>${escapeHtml(member.displayName || member.username || 'Member')}</strong>${member.id === state.user?.id ? '<small>YOU</small>' : ''}</div><div class="mission-member-progressbar"><span style="width:${percent}%"></span></div></div>${status}</div>`;
    }).join('') : '<div class="empty-state">No members have joined yet.</div>';
    return `<article class="community-mission-card"><div class="mission-card-top"><span class="eyebrow">${label}</span><span class="mission-reward">+${Number(mission.xp).toLocaleString()} XP · +${Number(mission.points).toLocaleString()} pts</span></div><h3>${escapeHtml(mission.title)}</h3><p>${escapeHtml(mission.description)}</p><div class="mission-members">${rows}</div></article>`;
  })).join('');
  return `<section class="missions-section community-missions-section"><div class="section-header"><div><span class="eyebrow">VISIBLE TO THE WHOLE COMMUNITY</span><h2>Everyone’s missions</h2></div><span class="mission-reset">Same daily & weekly tasks for every member</span></div><div class="community-missions-grid">${cards}</div></section>`;
}
async function refreshMissions() {
  if (!state.user) {
    state.missions = null;
    return;
  }
  try {
    state.missions = await fetchJson('/api/missions');
  } catch {
    state.missions = null;
  }
}

function renderRoomCard(room, index = 0) {
  return `
    <article class="room-card">
      <div class="room-art room-art-${index % 3}" role="img" aria-label="Atmosphere for ${escapeHtml(room.name)}">
        <span class="live-label"><span class="status-dot"></span>${escapeHtml(room.status || 'LIVE')}</span>
        ${room.locked ? '<span class="lock-label">INVITE ONLY</span>' : ''}
        <span class="room-art-index">${String(index + 1).padStart(2, '0')}</span>
      </div>
      <div class="room-card-content">
        <div class="room-meta"><span>${room.media_type === 'audio' ? 'LISTENING ROOM' : 'WATCH PARTY'}</span><span>HOSTED BY ${escapeHtml(getHostLabel(room).toUpperCase())}</span></div>
        <h3 class="room-name">${escapeHtml(room.name)}</h3>
        <div class="metric-row"><span>${Number(room.viewer_count || 0)} watching</span><button class="button button-small button-outline" type="button" data-action="watch-room" data-room-id="${escapeHtml(room.id)}">Join room <span aria-hidden="true">↗</span></button></div>
      </div>
    </article>
  `;
}

function renderBadges(badges = [], limit = badges.length) {
  if (!badges.length) return '<span class="badge-empty">No badges yet</span>';
  return badges.slice(0, limit).map((badge) => `
    <span class="achievement-badge rarity-${escapeHtml(badge.rarity || 'common')}" title="${escapeHtml(badge.description || badge.name)}">
      <span class="achievement-badge-icon">${escapeHtml(badge.icon || '★')}</span>
      <span>${escapeHtml(badge.name)}</span>
    </span>
  `).join('');
}

function renderLeaderboard(users = state.leaderboard, limit = users.length) {
  if (!users.length) return '<div class="empty-state">No community members to show yet.</div>';
  return users.slice(0, limit).map((user, index) => `
    <article class="member-row">
      <span class="rank-number">${String(index + 1).padStart(2, '0')}</span>
      <img class="avatar member-avatar" src="${escapeHtml(user.avatar || 'https://api.dicebear.com/7.x/adventurer/svg?seed=member')}" alt="" />
      <span class="member-name">${escapeHtml(user.display_name || user.username || 'Member')}${user.id === state.user?.id ? '<small>YOU</small>' : ''}${renderBadges(user.badges || [], 2)}</span>
      <span class="member-points">LEVEL ${Number(user.level || 1)} · ${Number(user.xp || 0).toLocaleString()} <small>XP</small></span>
    </article>
  `).join('');
}

function renderStudyLeaderboard(rows = state.studyLeaderboard, limit = rows.length) {
  if (!rows.length) return '<div class="empty-state">No study time recorded yet. Set a study voice channel with the Zenith bot first.</div>';
  return rows.slice(0, limit).map((user, index) => `
    <article class="member-row study-member-row">
      <span class="rank-number">${String(index + 1).padStart(2, '0')}</span>
      <img class="avatar member-avatar" src="${escapeHtml(user.avatar || 'https://api.dicebear.com/7.x/adventurer/svg?seed=member')}" alt="" />
      <span class="member-name">${escapeHtml(user.display_name || user.username || 'Member')}${user.id === state.user?.id ? '<small>YOU</small>' : ''}</span>
      <span class="member-points">${escapeHtml(user.duration || '0m')} <small>STUDY</small></span>
    </article>
  `).join('');
}

function renderEventCard(event, index = 0) {
  const date = new Date(event.start_time || Date.now());
  const joined = state.joinedEvents.has(event.id);
  return `
    <article class="event-card event-card-${index % 3}">
      <div class="event-date"><strong>${Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { day: '2-digit' })}</strong><span>${Number.isNaN(date.getTime()) ? 'TBA' : date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span></div>
      <div class="event-details"><span class="eyebrow">${escapeHtml(event.type || 'COMMUNITY EVENT')}</span><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.description || 'A little time together, right here in Zenith.')}</p><small>Hosted by ${escapeHtml(event.host || 'Zenith')} · ${Number.isNaN(date.getTime()) ? 'Time to be announced' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div>
      <button class="button ${joined ? 'button-quiet' : 'button-outline'} event-join" type="button" data-action="join-event" data-event-id="${escapeHtml(event.id)}" ${joined ? 'disabled' : ''}>${joined ? 'Going' : 'Join event'}</button>
    </article>
  `;
}

function renderHome() {
  const nextEvent = state.events[0];
  return `
    <section class="hero page-section">
      <div class="hero-copy">
        <span class="eyebrow"><span class="status-dot"></span> YOUR PEOPLE ARE HERE</span>
        <h1>Watch together.<br /><em>Stay a little longer.</em></h1>
        <p>Movie nights, familiar voices, spontaneous games. Your community has a place to land.</p>
        <div class="hero-actions"><button class="button button-primary" type="button" data-page="rooms">Explore live rooms <span aria-hidden="true">↗</span></button><button class="button button-quiet" type="button" data-page="games">Play today’s game</button></div>
        <div class="hero-footnote"><span class="online-pips"><i></i><i></i><i></i></span><span>${Number(state.status?.onlineUsers || 0).toLocaleString()} people around tonight</span></div>
      </div>
      <div class="hero-visual">
        <img src="https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1200&q=85" alt="Rows of seats in a warmly lit cinema" />
        <div class="visual-caption"><span class="live-label"><span class="status-dot"></span>LIVE NOW</span><strong>${state.rooms.length} rooms are open</strong><span>Pick a room. Bring a friend.</span></div>
      </div>
    </section>

    ${state.user ? `<section class="welcome-strip"><div><span class="eyebrow">WELCOME BACK</span><strong>${escapeHtml(state.user.displayName || state.user.username)}</strong></div><div class="welcome-xp"><span>LEVEL ${state.user.level || 1}</span><strong>${Number(state.user.xp || 0).toLocaleString()} XP</strong></div><button class="button button-icon button-outline" type="button" data-page="community" aria-label="View your profile">↗</button></section>${renderMissions(true)}` : ''}

    <section class="page-section">
      <div class="section-header"><div><span class="eyebrow">HAPPENING RIGHT NOW</span><h2>Rooms with the lights on</h2></div><button class="text-link" type="button" data-page="rooms">All rooms <span aria-hidden="true">↗</span></button></div>
      <div class="room-grid">${state.rooms.length ? state.rooms.slice(0, 3).map(renderRoomCard).join('') : '<div class="empty-state">No rooms are live right now. Start one for your crew.</div>'}</div>
    </section>

    <section class="home-columns page-section">
      <div class="home-events"><div class="section-header"><div><span class="eyebrow">SAVE YOUR SPOT</span><h2>Coming up</h2></div><button class="text-link" type="button" data-page="events">Event calendar ↗</button></div>
        ${nextEvent ? renderEventCard(nextEvent) : '<div class="empty-state">Nothing on the calendar yet. Make it a good night.</div>'}
      </div>
      <aside class="leaderboard-preview"><div class="section-header"><div><span class="eyebrow">THE REGULARS</span><h2>Community pulse</h2></div><button class="text-link" type="button" data-page="community">Full board ↗</button></div><div class="member-list">${renderLeaderboard(state.leaderboard, 4)}</div></aside>
    </section>

    <section class="daily-banner page-section"><div><span class="eyebrow">SAME PUZZLE, EVERYONE</span><h2>A five-letter daily challenge.</h2><p>Six tries. One word. Compare notes after.</p></div><button class="button button-primary" type="button" data-page="games">Take your guess <span aria-hidden="true">↗</span></button></section>
  `;
}

function renderRooms() {
  const canCreateRoom = Boolean(state.user?.owner);
  return `
    <section class="page-section page-heading"><span class="eyebrow">PICK YOUR CORNER</span><div class="heading-row"><div><h1>Open rooms</h1><p>Somewhere to watch, listen, or just be around people.</p></div>${canCreateRoom ? '<button class="button button-primary" type="button" data-action="focus-room-form">Create a room <span aria-hidden="true">＋</span></button>' : ''}</div></section>
    <section class="room-tools"><label class="search-field"><span aria-hidden="true">⌕</span><input id="roomSearch" type="search" placeholder="Find a room" aria-label="Search rooms" /></label><span class="room-count"><span class="status-dot"></span>${state.rooms.length} LIVE</span></section>
    <section class="room-grid room-grid-page" id="roomGrid">${state.rooms.length ? state.rooms.map(renderRoomCard).join('') : '<div class="empty-state">No rooms available. Create the first one.</div>'}</section>
    <section class="create-room-section" id="createRoomSection">${canCreateRoom ? '<div class="create-room-copy"><span class="eyebrow">MAKE IT YOURS</span><h2>Start a watch party</h2><p>Bring your people and a direct video link. You can host the room right away.</p></div><form id="createRoomForm" class="form-grid"><label>Room name<input name="name" type="text" maxlength="80" placeholder="Friday night comfort movie" required /></label><label>Media source<input name="mediaUrl" type="url" placeholder="Direct video, YouTube, or Vimeo URL" required /></label><button class="button button-primary" type="submit">Open room <span aria-hidden="true">↗</span></button></form>' : '<div class="create-room-copy"><span class="eyebrow">WATCH PARTIES</span><h2>Join a room</h2><p>Watch parties are hosted by the server owner. Pick an open room above to join.</p></div>'}</section>
  `;
}
function renderWatch() {
  const room = state.rooms.find((entry) => entry.id === state.roomId);
  if (!room) return `<section class="page-section watch-empty"><span class="eyebrow">WATCH TOGETHER</span><h1>Choose a room.</h1><p>Pick a live room and settle in.</p><div class="room-grid">${state.rooms.map(renderRoomCard).join('')}</div></section>`;
  const messages = state.messages.length ? state.messages : state.latestMessages.filter((message) => message.room_id === room.id);
  const isHost = room.host_user_id === state.user?.id;
  const activeUsers = state.activeUsers.map((user) => escapeHtml(user.displayName || user.username)).join(', ');
  return `
    <section class="page-section watch-heading"><div><button class="back-link" type="button" data-page="rooms">← All rooms</button><div class="watch-room-title"><span class="eyebrow"><span class="status-dot"></span> LIVE WATCH PARTY</span><h1>${escapeHtml(room.name)}</h1><span>Hosted by ${escapeHtml(getHostLabel(room))}</span></div><div class="watch-presence"><span id="viewerCount">${Number(room.viewer_count || 0)} watching</span><span id="activeMembers">${activeUsers || 'Waiting for people to join'}</span></div></div><button class="button button-quiet" type="button" data-action="leave-room">Leave room</button></section>
    <section class="watch-layout">
      <div class="watch-main"><div class="video-frame" id="videoFrame"><div id="watchPlayer" class="watch-player"></div><button id="playbackHint" class="playback-hint is-hidden" type="button" data-action="enable-playback">Tap to join playback</button><div class="player-tools"><button class="button button-small button-glass" type="button" data-action="toggle-player-fullscreen">Fullscreen</button><button class="button button-small button-glass" type="button" data-action="toggle-fullscreen-chat">Chat</button></div><div class="chat-toasts" id="chatToasts" aria-live="polite"></div><div class="fullscreen-chat is-hidden" id="fullscreenChat"><header><strong>Room chat</strong><button class="button button-small button-glass" type="button" data-action="toggle-fullscreen-chat" aria-label="Close chat">×</button></header><div class="chat-messages" id="fullscreenChatMessages" aria-live="polite">${messages.length ? messages.map(renderChatMessage).join('') : '<div class="chat-empty">No messages yet.</div>'}</div>${state.user ? '<form id="fullscreenChatForm" class="chat-form"><input name="text" maxlength="240" autocomplete="off" placeholder="Write a message…" aria-label="Chat message" required /><button class="button button-primary button-icon" type="submit" aria-label="Send message">↑</button></form>' : ''}</div><span class="video-live"><span class="status-dot"></span>HOST-SYNCED</span></div><div class="watch-details"><div><span class="eyebrow">ROOM DETAILS</span><h2>${escapeHtml(room.name)}</h2></div><div class="watch-host"><img class="avatar" src="${escapeHtml(room.host_avatar || state.leaderboard.find((user) => user.id === room.host_user_id)?.avatar || '')}" alt="" /><span>Hosted by<strong>${escapeHtml(getHostLabel(room))}</strong></span></div><span id="roomLockStatus" class="room-lock-state">${room.locked ? 'Locked to new viewers' : 'Open to the community'}</span></div>
        ${isHost ? `<section class="host-controls"><div><span class="eyebrow">HOST CONTROLS</span><p>Changes sync to everyone in this room.</p></div><form id="mediaForm" class="host-media-form"><label for="mediaUrlInput">Change media source</label><div><input id="mediaUrlInput" name="mediaUrl" type="url" value="${escapeHtml(room.media_url)}" required /><button class="button button-small button-outline" type="submit">Update source</button></div></form><button class="button button-small button-outline" type="button" data-action="toggle-room-lock" data-locked="${room.locked ? 'true' : 'false'}">${room.locked ? 'Unlock room' : 'Lock room'}</button><button class="button button-small button-danger" type="button" data-action="end-room">End room</button></section>` : ''}
      </div>
      <aside class="chat-panel"><header class="chat-header"><div><span class="eyebrow">ROOM CHAT</span><h2>Say hello</h2></div><span class="chat-live"><span class="status-dot"></span><span id="chatConnection">CONNECTING</span></span></header><div class="chat-messages" id="chatMessages" aria-live="polite">${messages.length ? messages.map(renderChatMessage).join('') : '<div class="chat-empty">First one here? Break the ice.</div>'}</div>${state.user ? `<form id="chatForm" class="chat-form"><input name="text" maxlength="240" autocomplete="off" placeholder="Write a message…" aria-label="Chat message" required /><button class="button button-primary button-icon" type="submit" aria-label="Send message">↑</button></form>` : signInPrompt('Sign in to join the conversation', 'chat-sign-in')}</aside>
    </section>
  `;
}

function renderRoomEnded() {
  const room = state.endedRoom || state.rooms.find((entry) => entry.id === state.roomId);
  return `<section class="page-section room-ended-state"><span class="eyebrow">WATCH PARTY COMPLETE</span><h1>Movie Finished</h1><p>${room ? `${escapeHtml(room.name)} has ended.` : 'The watch party has ended.'}</p><p class="room-ended-meta">${room?.end_reason === 'media_ended' ? 'The media reached its end.' : 'The host ended this room.'}${room?.ended_at ? ` · ${new Date(room.ended_at).toLocaleString()}` : ''}</p><button class="button button-primary" type="button" data-page="rooms">Back to Rooms</button></section>`;
}

function renderChatMessage(message) {
  const name = message.display_name || message.username || 'Member';
  return `<article class="chat-message"><img class="avatar" src="${escapeHtml(message.avatar || 'https://api.dicebear.com/7.x/adventurer/svg?seed=member')}" alt="" /><div><div class="chat-message-meta"><strong>${escapeHtml(name)}</strong><time>${escapeHtml(message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'now')}</time></div><p>${escapeHtml(message.content || '')}</p></div></article>`;
}

function renderSeasonHistory() {
  if (!state.seasonHistory.length) return '';
  return `<section class="historical-note"><div><span class="eyebrow">SEASON HISTORY</span><h2>Previous months</h2><p>Your completed monthly seasons stay archived even after the current season resets.</p></div><div class="season-history-list">${state.seasonHistory.map((season) => `<article><strong>${escapeHtml(season.season_key)}</strong><span>${Number(season.xp || 0).toLocaleString()} XP · ${Number(season.points || 0).toLocaleString()} points</span><span>${Number(season.messages || 0).toLocaleString()} messages · ${Number(season.study_seconds || 0) >= 3600 ? Math.floor(Number(season.study_seconds) / 3600) + 'h' : Math.floor(Number(season.study_seconds || 0) / 60) + 'm'}</span><span>${Number(season.badge_count || 0)} badges</span></article>`).join('')}</div></section>`;
}

function renderCommunity() {
  const users = [...state.leaderboard].sort((left, right) => Number(right.message_count || 0) - Number(left.message_count || 0));
  const periods = [
    ['today', 'Today'],
    ['this_week', 'This week'],
    ['this_month', 'This month'],
  ];
  const trackedSince = state.tracking?.trackingStartedAt
    ? new Date(state.tracking.trackingStartedAt).toLocaleDateString(undefined, { dateStyle: 'long', timeZone: 'UTC' })
    : 'Waiting for the bot to connect';
  return `
    <section class="page-section page-heading"><span class="eyebrow">ACTIVITY FROM YOUR DISCORD SERVER</span><div class="heading-row"><div><h1>Most active</h1><p>Monthly competition. XP, points, and badges reset at the start of each month.</p></div><div class="community-total"><strong>${users.length.toString().padStart(2, '0')}</strong><span>MEMBERS<br />IN THIS PERIOD</span></div></div></section>
    ${renderCommunityMissions()}
    ${state.user ? `<section class="profile-summary"><img class="profile-avatar" src="${escapeHtml(state.user.avatar)}" alt="" /><div class="profile-identity"><span class="eyebrow">YOUR DISCORD PROFILE</span><h2>${escapeHtml(state.user.displayName || state.user.username)}</h2><span>Discord member · ${Number(state.user.trackedMessageCount || 0).toLocaleString()} messages this month</span><div class="profile-badges">${renderBadges(state.user.badges || [], 8)}</div></div><div class="profile-stat"><strong>${Number(state.user.trackedMessageCount || 0).toLocaleString()}</strong><span>TRACKED HERE</span></div></section>${renderMissions()}` : ''}
    <section class="leaderboard-section"><div class="section-header"><div><span class="eyebrow">MOST ACTIVE</span><h2>Discord message leaderboard</h2></div><label class="search-field compact-search"><span aria-hidden="true">⌕</span><input id="communitySearch" type="search" placeholder="Find a member" aria-label="Search members" /></label></div><div class="period-tabs" role="group" aria-label="Leaderboard period">${periods.map(([period, label]) => `<button type="button" data-period="${period}" class="${state.leaderboardPeriod === period ? 'is-active' : ''}">${label}</button>`).join('')}</div><div class="member-list leaderboard-list" id="leaderboardList">${renderLeaderboard(users)}</div><p class="tracking-note">Current monthly season · tracked by Zenith since <strong>${escapeHtml(trackedSince)}</strong>. Lifetime totals are kept separately.</p></section>
    <section class="leaderboard-section study-leaderboard-section"><div class="section-header"><div><span class="eyebrow">FOCUS MODE</span><h2>Study VC leaderboard</h2></div><span class="tracking-note">${state.studyChannelId ? 'Time spent in the configured study voice channel.' : 'No study voice channel configured yet.'}</span></div><div class="member-list leaderboard-list">${renderStudyLeaderboard(state.studyLeaderboard)}</div></section>
    ${renderSeasonHistory()}
    <section class="historical-note"><div><span class="eyebrow">SEPARATE FROM LIVE TRACKING</span><h2>Historical Discord messages</h2><p>${escapeHtml(state.tracking?.historicalScope || 'Historical messages are not imported or included in this leaderboard.')}</p></div><strong>Not imported</strong></section>
  `;
}

function renderGames() {
  const rows = Array.from({ length: 6 }, (_, rowIndex) => {
    const guess = state.game.guesses[rowIndex];
    return `<div class="guess-row ${guess ? 'has-guess' : ''}" aria-label="Attempt ${rowIndex + 1}">${Array.from({ length: 5 }, (_, letterIndex) => {
      const letter = guess?.guess?.[letterIndex] || '';
      const result = guess?.result?.[letterIndex] || '';
      return `<span class="guess-tile ${result}">${escapeHtml(letter)}</span>`;
    }).join('')}</div>`;
  }).join('');
  const gameFinished = state.game.solved || state.game.guesses.length >= 6;
  return `
    <section class="page-section page-heading game-heading"><span class="eyebrow">TODAY’S COMMUNITY PUZZLE</span><div class="heading-row"><div><h1>Word on the street.</h1><p>One five-letter word. Six tries. Everyone gets the same one.</p></div><div class="game-date"><span>TODAY</span><strong>${new Date().toLocaleDateString(undefined, { month: 'short', day: '2-digit' }).toUpperCase()}</strong></div></div></section>
    <section class="game-layout"><div class="game-board-wrap"><div class="game-board" aria-label="Six attempts, five letters each">${rows}</div>${state.game.solved ? '<p class="game-result success-result">That’s the word. Nice read.</p>' : state.game.guesses.length >= 6 ? '<p class="game-result">No more tries today. Come back for tomorrow’s puzzle.</p>' : ''}${state.user ? `<form id="guessForm" class="guess-form"><label for="guessInput">Your next guess</label><div><input id="guessInput" name="guess" type="text" maxlength="5" minlength="5" pattern="[A-Za-z]{5}" autocomplete="off" autocapitalize="characters" placeholder="5 LETTERS" ${gameFinished ? 'disabled' : ''} required /><button class="button button-primary" type="submit" ${gameFinished ? 'disabled' : ''}>Submit guess <span aria-hidden="true">↗</span></button></div></form>` : signInPrompt('Sign in to play', 'button button-primary')}</div>
      <aside class="game-aside"><div class="game-rule"><span class="eyebrow">HOW THE TILES READ</span><div class="rule-row"><span class="rule-tile green">A</span><span>Right letter, right place</span></div><div class="rule-row"><span class="rule-tile yellow">R</span><span>In the word, different place</span></div><div class="rule-row"><span class="rule-tile gray">T</span><span>Not in today’s word</span></div></div><div class="game-streak"><span class="eyebrow">YOUR STREAK</span><strong>${Number(state.user?.currentStreak || 0)} <small>DAYS</small></strong><span>Come back tomorrow to keep it going.</span></div></aside>
    </section>
  `;
}

function getLocalDateTimeInputMin() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return date;
}

function renderEvents() {
  const canManageEvents = Boolean(state.user?.admin);
  return `
    <section class="page-section page-heading"><span class="eyebrow">PUT IT ON THE CALENDAR</span><div class="heading-row"><div><h1>Plans worth keeping.</h1><p>Movie nights, game sessions, and whatever the community dreams up.</p></div>${canManageEvents ? '<button class="button button-primary" type="button" data-action="toggle-event-form">Host an event <span aria-hidden="true">＋</span></button>' : ''}</div></section>
    ${canManageEvents ? `<section class="event-create-wrap is-hidden" id="eventCreateWrap"><form id="createEventForm" class="form-grid event-form"><label>Event title<input name="title" maxlength="100" placeholder="Late-night double feature" required /></label><label>Type<select name="type"><option>COMMUNITY EVENT</option><option>MOVIE NIGHT</option><option>MUSIC NIGHT</option><option>GAME NIGHT</option></select></label><label class="form-wide">A little context<textarea name="description" maxlength="240" rows="2" placeholder="What should people know?"></textarea></label><label>Starts<input name="startTime" type="datetime-local" min="${getLocalDateTimeInputMin()}" step="60" required /></label><label>Ends<input name="endTime" type="datetime-local" min="${getLocalDateTimeInputMin()}" step="60" required /></label><button class="button button-primary" type="submit">Publish event ↗</button></form></section>` : ''}
    <section class="events-list">${state.events.length ? state.events.map(renderEventCard).join('') : '<div class="empty-state">No plans on the calendar yet.</div>'}</section>
  `;
}
function renderStatusPage() {
  const discordReady = state.status?.discordAuth === 'Configured' && state.status?.discordBot === 'Connected';
  const coreReady = ['website', 'api', 'websocket', 'database'].every((key) => state.status?.[key] === 'Operational');
  const statusLabel = coreReady && discordReady ? 'ALL SYSTEMS OPERATIONAL' : coreReady ? 'DISCORD INTEGRATION NOT CONFIGURED' : 'SERVICE STATUS UNAVAILABLE';
  return `<section class="page-section page-heading"><span class="eyebrow">ALL SYSTEMS, AT A GLANCE</span><div class="heading-row"><div><h1>Server status</h1><p>Live service and Discord connection state.</p></div><span class="status-overall"><span class="status-dot"></span>${statusLabel}</span></div></section><section class="status-grid">${renderStatus(state.status)}</section><p class="status-footnote">Status is read from the current server and bot connection.</p>`;
}

function renderApp() {
  const views = {
    home: renderHome,
    rooms: renderRooms,
    watch: renderWatch,
    'room-ended': renderRoomEnded,
    community: renderCommunity,
    games: renderGames,
    events: renderEvents,
    status: renderStatusPage,
  };
  appEl.innerHTML = (views[state.page] || renderHome)();
  if (state.page === 'watch') mountWatchPlayer();
}

function readLocation() {
  const [page, roomId] = window.location.hash.replace(/^#/, '').split('/');
  state.page = pages.includes(page) ? page : 'home';
  if (!roomId && !['watch', 'room-ended'].includes(state.page)) state.roomId = null;
  if (roomId) {
    try {
      state.roomId = decodeURIComponent(roomId);
    } catch {
      state.roomId = roomId;
    }
  }
}

function updateRoomPresence(viewerCount, users = []) {
  state.activeUsers = users;
  const count = document.querySelector('#viewerCount');
  const members = document.querySelector('#activeMembers');
  if (count) count.textContent = `${Number(viewerCount || 0)} watching`;
  if (members) members.textContent = users.map((user) => user.displayName || user.username).join(', ') || 'Waiting for people to join';
}

function updateRoomRecord(room) {
  if (!room) return;
  state.rooms = state.rooms.map((entry) => entry.id === room.id ? { ...entry, ...room } : entry);
  const lockState = document.querySelector('#roomLockStatus');
  if (lockState) lockState.textContent = room.locked ? 'Locked to new viewers' : 'Open to the community';
  const lockButton = document.querySelector('[data-action="toggle-room-lock"]');
  if (lockButton) {
    lockButton.dataset.locked = String(Boolean(room.locked));
    lockButton.textContent = room.locked ? 'Unlock room' : 'Lock room';
  }
}

async function applyRoomSnapshot(message) {
  updateRoomRecord(message.room);
  updateRoomPresence(message.viewerCount ?? message.room?.viewer_count, message.users || []);
  state.playback = message.playback || state.playback;
  if (state.playback && state.mediaProvider) {
    await state.mediaProvider.apply('seek', state.playback.position);
    await state.mediaProvider.apply(state.playback.state === 'playing' ? 'play' : 'pause', state.playback.position);
  }
}

function appendChatMessage(message) {
  state.messages.push(message);
  const html = renderChatMessage(message);
  for (const selector of ['#chatMessages', '#fullscreenChatMessages']) {
    const chat = document.querySelector(selector);
    if (!chat) continue;
    chat.querySelector('.chat-empty')?.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    if (wrapper.firstElementChild) chat.append(wrapper.firstElementChild);
    chat.scrollTop = chat.scrollHeight;
  }

  const toastStack = document.querySelector('#chatToasts');
  if (toastStack) {
    const toast = document.createElement('div');
    toast.className = 'chat-toast';
    toast.innerHTML = html;
    toastStack.append(toast);
    window.setTimeout(() => {
      toast.classList.add('is-fading');
      window.setTimeout(() => toast.remove(), 350);
    }, 4200);
  }
}

async function handleRoomSocketMessage(event, roomId) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.roomId && message.roomId !== state.roomId) return;

  if (message.type === 'room_snapshot' || message.type === 'room_state') {
    await applyRoomSnapshot(message);
  } else if (message.type === 'presence') {
    updateRoomPresence(message.viewerCount, message.users);
  } else if (message.type === 'chat_message') {
    appendChatMessage(message.message);
  } else if (message.type === 'playback_sync') {
    state.playback = { state: message.state, position: message.position, serverTime: message.serverTime };
    if (message.by !== state.user?.id && state.mediaProvider) {
      const elapsed = message.state === 'playing' && Number.isFinite(Number(message.serverTime))
        ? Math.max(0, (Date.now() - Number(message.serverTime)) / 1000)
        : 0;
      const targetPosition = Number(message.position) + (['play', 'sync'].includes(message.action) ? elapsed : 0);
      await state.mediaProvider.apply(message.action, targetPosition);
    }
  } else if (message.type === 'media_changed') {
    updateRoomRecord(message.room);
    state.playback = { state: 'paused', position: 0 };
    renderApp();
    showToast('The host changed the media source.', 'info');
  } else if (message.type === 'room_locked') {
    updateRoomRecord({ id: roomId, locked: message.locked });
    showToast(message.locked ? 'The room is locked to new viewers.' : 'The room is open again.', 'info');
  } else if (message.type === 'room_ended') {
    state.endedRoom = { ...state.rooms.find((room) => room.id === roomId), status: 'ended', ended_at: message.endedAt, end_reason: message.reason };
    navigate('room-ended', roomId);
  } else if (message.type === 'force_leave') {
    showToast('You left the room.', 'info');
    navigate('rooms');
  } else if (message.type === 'error') {
    showToast(message.error || 'Room connection error.', 'error');
  }
}

function scheduleRoomReconnect(roomId) {
  if (state.page !== 'watch' || state.roomId !== roomId || !state.user) return;
  window.clearTimeout(state.reconnectTimer);
  const delay = Math.min(30000, 1000 * (2 ** Math.min(state.reconnectAttempts, 5)));
  state.reconnectAttempts += 1;
  const status = document.querySelector('#chatConnection');
  if (status) status.textContent = 'Reconnecting…';
  state.reconnectTimer = window.setTimeout(() => connectRoomSocket(roomId), delay);
}

function connectRoomSocket(roomId) {
  if (!state.user || state.page !== 'watch') return;
  if (state.socketRoomId === roomId && state.socket && state.socket.readyState < WebSocket.CLOSING) return;
  if (state.connectingRoomId === roomId && state.socketConnectPromise) return state.socketConnectPromise;
  window.clearTimeout(state.reconnectTimer);
  state.connectingRoomId = roomId;
  state.socketConnectPromise = (async () => {
    try {
      if (state.roomJoinReadyForSocket === roomId) {
        state.roomJoinReadyForSocket = null;
      } else {
        await fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST' });
      }
      if (state.page !== 'watch' || state.roomId !== roomId) return;
      if (state.socket) state.socket.close();
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws`);
      state.socket = socket;
      state.socketRoomId = roomId;
      socket.addEventListener('open', () => {
        state.reconnectAttempts = 0;
        socket.send(JSON.stringify({ type: 'join_room', roomId }));
        const status = document.querySelector('#chatConnection');
        if (status) status.textContent = 'CONNECTED';
      });
      socket.addEventListener('message', (event) => handleRoomSocketMessage(event, roomId));
      socket.addEventListener('close', () => {
        if (state.socket === socket) {
          state.socket = null;
          state.socketRoomId = null;
          scheduleRoomReconnect(roomId);
        }
      });
      socket.addEventListener('error', () => {
        const status = document.querySelector('#chatConnection');
        if (status) status.textContent = 'CONNECTION INTERRUPTED';
      });
    } catch (error) {
      showToast(error.message, 'error');
      if (error.message.includes('locked') || error.message.includes('not found')) navigate('rooms');
    } finally {
      state.connectingRoomId = null;
      state.socketConnectPromise = null;
    }
  })();
  return state.socketConnectPromise;
}

function mountWatchPlayer() {
  const room = state.rooms.find((entry) => entry.id === state.roomId);
  const container = document.querySelector('#watchPlayer');
  if (!room || !container || !window.ZenithMediaProviders) return;
  state.mediaProvider?.destroy();
  window.clearInterval(state.playbackSyncTimer);
  state.playbackSyncTimer = null;
  const media = {
    provider: room.media_provider,
    source_url: room.media_url,
    embed_url: room.media_embed_url,
  };
  const host = room.host_user_id === state.user?.id;
  try {
    state.mediaProvider = window.ZenithMediaProviders.createMediaProvider(media, {
      host,
      onAction: (action, position) => {
        if (state.socket?.readyState === WebSocket.OPEN) {
          state.socket.send(JSON.stringify({ type: 'playback', action, position }));
        }
      },
    });
    const mountedProvider = state.mediaProvider;
    Promise.resolve(mountedProvider.mount(container)).then(async () => {
      if (state.playback && state.mediaProvider === mountedProvider) {
        await mountedProvider.apply('seek', state.playback.position);
        await mountedProvider.apply(state.playback.state === 'playing' ? 'play' : 'pause', state.playback.position);
      }
      if (host && state.mediaProvider === mountedProvider) {
        state.playbackSyncTimer = window.setInterval(async () => {
          if (state.page !== 'watch' || state.roomId !== room.id ||
              state.socket?.readyState !== WebSocket.OPEN ||
              state.playback?.state !== 'playing') return;
          try {
            const position = await mountedProvider.getCurrentTime?.();
            if (Number.isFinite(Number(position))) {
              state.socket.send(JSON.stringify({ type: 'playback', action: 'sync', position: Number(position) }));
            }
          } catch {
            // A provider can briefly be unavailable while buffering.
          }
        }, 1000);
      }
    }).catch((error) => {
      container.textContent = error.message || 'This media provider could not be loaded.';
      container.classList.add('player-error');
    });
  } catch (error) {
    container.textContent = error.message;
    container.classList.add('player-error');
  }
}

function gameStorageKey() {
  return 'zenith-word-cache';
}

async function refreshDailyGame() {
  if (!state.user) return;
  try {
    const game = await fetchJson('/api/games/daily-word');
    state.game = { guesses: Array.isArray(game.attempts) ? game.attempts : [], solved: Boolean(game.solved), answer: game.answer || '' };
    saveGame();
    if (state.page === 'games') renderApp();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function loadSavedGame() {
  try {
    const saved = JSON.parse(localStorage.getItem(gameStorageKey()) || 'null');
    if (saved && Array.isArray(saved.guesses)) state.game = { ...state.game, ...saved };
  } catch {
    localStorage.removeItem(gameStorageKey());
  }
}

function saveGame() {
  localStorage.setItem(gameStorageKey(), JSON.stringify(state.game));
}

async function refreshLeaderboard(period) {
  try {
    const response = await fetchJson(`/api/community/leaderboard?period=${encodeURIComponent(period)}`);
    if (state.page !== 'community' || state.leaderboardPeriod !== period) return;
    state.leaderboard = response.users || [];
    state.studyLeaderboard = response.studyLeaderboard || [];
    state.studyChannelId = response.studyChannelId || '';
    state.tracking = response.tracking || null;
    state.memberCount = Number.isFinite(Number(state.tracking?.memberCount)) ? Number(state.tracking.memberCount) : null;
    renderApp();
    window.clearTimeout(state.studyRefreshTimer);
    state.studyRefreshTimer = window.setTimeout(() => refreshLeaderboard(period), 30000);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleClick(event) {
  const periodControl = event.target.closest('[data-period]');
  if (periodControl) {
    state.leaderboardPeriod = periodControl.dataset.period;
    await refreshLeaderboard(state.leaderboardPeriod);
    return;
  }

  const pageLink = event.target.closest('[data-page]');
  if (pageLink) {
    event.preventDefault();
    navigate(pageLink.dataset.page);
    topbarEl.querySelector('.nav')?.classList.remove('is-open');
    topbarEl.querySelector('.mobile-menu-toggle')?.setAttribute('aria-expanded', 'false');
    return;
  }

  const control = event.target.closest('[data-action]');
  if (!control) return;
  const action = control.dataset.action;

  if (action === 'claim-mission') {
    control.disabled = true;
    try {
      const { user, missions } = await fetchJson(`/api/missions/${encodeURIComponent(control.dataset.missionId)}/claim`, {
        method: 'POST',
        body: JSON.stringify({ periodKey: control.dataset.periodKey }),
      });
      state.user = user || state.user;
      state.missions = missions || state.missions;
      renderTopbar();
      renderApp();
      showToast('Mission reward claimed.', 'success');
    } catch (error) {
      control.disabled = false;
      showToast(error.message, 'error');
      await refreshMissions();
      renderApp();
    }
    return;
  }
  if (action === 'toggle-nav') {
    const open = topbarEl.querySelector('.nav')?.classList.toggle('is-open');
    control.setAttribute('aria-expanded', String(Boolean(open)));
  } else if (action === 'focus-room-form') {
    document.querySelector('#createRoomSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelector('#createRoomForm [name="name"]')?.focus();
  } else if (action === 'toggle-event-form') {
    if (!state.user?.admin) return;
    const form = document.querySelector('#eventCreateWrap');
    form?.classList.toggle('is-hidden');
    if (form && !form.classList.contains('is-hidden')) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (action === 'toggle-player-fullscreen') {
    const playerFrame = document.querySelector('#videoFrame');
    if (!playerFrame) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await playerFrame.requestFullscreen();
    } catch {
      showToast('Fullscreen is not available in this browser.', 'error');
    }
  } else if (action === 'toggle-fullscreen-chat') {
    document.querySelector('#fullscreenChat')?.classList.toggle('is-hidden');
  } else if (action === 'watch-room') {
    if (!state.user) {
      startDiscordLogin();
      return;
    }
    control.disabled = true;
    try {
      const roomId = encodeURIComponent(control.dataset.roomId);
      const { room } = await fetchJson(`/api/rooms/${roomId}/join`, { method: 'POST' });
      state.rooms = [room, ...state.rooms.filter((entry) => entry.id !== room.id)];
      state.roomId = room.id;
      state.roomJoinReadyForSocket = room.id;
      state.messages = [];
      state.activeUsers = [];
      state.playback = null;
      navigate('watch', room.id);
      // Load chat history and missions in the background so they do not delay the player.
      fetchJson(`/api/rooms/${roomId}/messages`).then(({ messages }) => {
        if (state.page === 'watch' && state.roomId === room.id) {
          state.messages = messages || [];
          const chat = document.querySelector('#chatMessages');
          const fullscreenChat = document.querySelector('#fullscreenChatMessages');
          for (const target of [chat, fullscreenChat]) {
            if (!target) continue;
            target.innerHTML = state.messages.length
              ? state.messages.map(renderChatMessage).join('')
              : '<div class="chat-empty">No messages yet.</div>';
            target.scrollTop = target.scrollHeight;
          }
        }
      }).catch(() => {});
      refreshMissions();
    } catch (error) {
      showToast(error.message, 'error');
      control.disabled = false;
    }
  } else if (action === 'join-event') {
    if (!state.user) {
      startDiscordLogin();
      return;
    }
    control.disabled = true;
    try {
      await fetchJson(`/api/events/${encodeURIComponent(control.dataset.eventId)}/join`, { method: 'POST' });
      state.joinedEvents.add(control.dataset.eventId);
      await refreshMissions();
      renderApp();
      showToast('You’re on the list. See you there.', 'success');
    } catch (error) {
      control.disabled = false;
      showToast(error.message, 'error');
    }
  } else if (action === 'leave-room') {
    const roomId = state.roomId;
    navigate('rooms');
    try {
      await fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST' });
      showToast('You left the room.', 'info');
    } catch (error) {
      showToast(error.message, 'error');
    }
  } else if (action === 'toggle-room-lock') {
    try {
      const locked = control.dataset.locked !== 'true';
      await fetchJson(`/api/rooms/${encodeURIComponent(state.roomId)}/lock`, {
        method: 'PATCH',
        body: JSON.stringify({ locked }),
      });
      updateRoomRecord({ id: state.roomId, locked });
      showToast(locked ? 'Room locked to new viewers.' : 'Room is open to the community.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  } else if (action === 'end-room') {
    if (!window.confirm('End this watch party for everyone?')) return;
    try {
      const roomId = state.roomId;
      const { endedAt, reason } = await fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/end`, { method: 'POST' });
      state.endedRoom = { ...state.rooms.find((room) => room.id === roomId), status: 'ended', ended_at: endedAt, end_reason: reason };
      navigate('room-ended', roomId);
    } catch (error) {
      showToast(error.message, 'error');
    }
  } else if (action === 'enable-playback') {
    state.mediaProvider?.enablePlayback?.();
  } else if (action === 'logout') {
    try {
      await fetchJson('/auth/logout', { method: 'POST' });
      if (state.socket) state.socket.close();
      state.mediaProvider?.destroy();
      state.socket = null;
      state.socketRoomId = null;
      state.user = null;
      renderTopbar();
      renderApp();
      showToast('You’ve signed out.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form.matches('form')) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;

  try {
    if (form.id === 'createRoomForm') {
      const data = new FormData(form);
      const { room } = await fetchJson('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), mediaUrl: data.get('mediaUrl') }),
      });
      state.rooms = [room, ...state.rooms.filter((entry) => entry.id !== room.id)];
      state.roomId = room.id;
      state.roomJoinReadyForSocket = room.id;
      state.messages = [];
      state.playback = { state: 'paused', position: 0, serverTime: Date.now() };
      showToast('Your room is open.', 'success');
      navigate('watch', room.id);
      refreshMissions();
    } else if (form.id === 'mediaForm') {
      const mediaUrl = new FormData(form).get('mediaUrl');
      const { room } = await fetchJson(`/api/rooms/${encodeURIComponent(state.roomId)}/media`, {
        method: 'PATCH',
        body: JSON.stringify({ mediaUrl }),
      });
      updateRoomRecord(room);
      state.playback = { state: 'paused', position: 0 };
      renderApp();
      showToast('Media source updated for everyone.', 'success');
    } else if (form.id === 'chatForm' || form.id === 'fullscreenChatForm') {
      const text = String(new FormData(form).get('text') || '').trim();
      if (!text || !state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error('Chat is reconnecting. Try again in a moment.');
      state.socket.send(JSON.stringify({ type: 'chat_message', roomId: state.roomId, text }));
      form.reset();
      // Re-enable the send control after the server-side anti-spam window.
      if (submit) window.setTimeout(() => {
        if (submit.isConnected) submit.disabled = false;
      }, 750);
    } else if (form.id === 'guessForm') {
      const guess = new FormData(form).get('guess').trim().toUpperCase();
      const { result, solved, answer } = await fetchJson('/api/games/daily-word/guess', {
        method: 'POST',
        body: JSON.stringify({ guess }),
      });
      state.game.guesses.push({ guess, result });
      state.game.solved = solved;
      if (solved) state.game.answer = answer;
      saveGame();
      renderApp();
      await refreshMissions();
      if (solved) showToast('Puzzle solved. Well played.', 'success');
      else if (state.game.guesses.length >= 6) showToast('That was the last try. New puzzle tomorrow.', 'info');
      else document.querySelector('#guessInput')?.focus();
    } else if (form.id === 'createEventForm') {
      if (!state.user?.admin) throw new Error('Only server administrators can create events.');
      const data = new FormData(form);
      const startTime = parseLocalDateTime(data.get('startTime'));
      const endTime = parseLocalDateTime(data.get('endTime'));
      if (!startTime || !endTime) throw new Error('Choose a valid start and end date/time.');
      if (startTime.getTime() <= Date.now()) throw new Error('Choose a future start time.');
      if (endTime <= startTime) throw new Error('End time must be after the start time.');
      const { event: created } = await fetchJson('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: data.get('title'),
          type: data.get('type'),
          description: data.get('description'),
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        }),
      });
      state.events.push(created);
      state.events.sort((left, right) => new Date(left.start_time) - new Date(right.start_time));
      renderApp();
      showToast('Your event is on the calendar.', 'success');
    }
  } catch (error) {
    showToast(error.message, 'error');
    if (submit) submit.disabled = false;
  }
}

function handleInput(event) {
  if (event.target.id === 'roomSearch') {
    const query = event.target.value.trim().toLowerCase();
    const filtered = state.rooms.filter((room) => `${room.name} ${getHostLabel(room)}`.toLowerCase().includes(query));
    document.querySelector('#roomGrid').innerHTML = filtered.length ? filtered.map(renderRoomCard).join('') : '<div class="empty-state">No rooms match that search.</div>';
  }
  if (event.target.id === 'communitySearch') {
    const query = event.target.value.trim().toLowerCase();
    const filtered = state.leaderboard.filter((user) => `${user.display_name || ''} ${user.username || ''}`.toLowerCase().includes(query));
    const list = document.querySelector('#leaderboardList');
    if (list) list.innerHTML = renderLeaderboard(filtered);
  }
  if (event.target.id === 'guessInput') event.target.value = event.target.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 5);
}

async function loadInitial() {
  try {
    const [meResponse, home] = await Promise.all([
      fetch('/api/me', { credentials: 'same-origin' }),
      fetchJson('/api/home'),
    ]);
    state.user = meResponse.ok ? (await meResponse.json()).user : null;
    state.rooms = home.rooms || [];
    state.events = home.events || [];
    state.leaderboard = home.leaderboard || [];
    state.latestMessages = home.latestMessages || [];
    state.tracking = home.tracking || null;
    state.memberCount = Number.isFinite(Number(state.tracking?.memberCount)) ? Number(state.tracking.memberCount) : null;
    state.status = home.status || null;
  } catch (error) {
    state.rooms = [];
    state.events = [];
    state.leaderboard = [];
    state.latestMessages = [];
    state.tracking = null;
    state.status = null;
    showToast('Zenith could not reach the server. Refresh to try again.', 'error');
  }

  loadSavedGame();
  if (state.user) {
    // These are non-critical for opening a watch room; do not block the first paint/player.
    Promise.all([
      refreshDailyGame(),
      refreshMissions(),
      fetchJson('/api/seasons/history').then((response) => { state.seasonHistory = response.history || []; }).catch(() => { state.seasonHistory = []; }),
    ]).catch(() => {});
  }
  if (state.page === 'watch' && state.roomId && state.user) {
    try {
      await fetchJson(`/api/rooms/${encodeURIComponent(state.roomId)}/join`, { method: 'POST' });
      state.roomJoinReadyForSocket = state.roomId;
      const [snapshot, chat] = await Promise.all([
        fetchJson(`/api/rooms/${encodeURIComponent(state.roomId)}`),
        fetchJson(`/api/rooms/${encodeURIComponent(state.roomId)}/messages`),
      ]);
      state.rooms = state.rooms.some((room) => room.id === snapshot.room.id)
        ? state.rooms.map((room) => room.id === snapshot.room.id ? { ...room, ...snapshot.room } : room)
        : [snapshot.room, ...state.rooms];
      state.messages = chat.messages || [];
      state.playback = snapshot.playback;
      state.activeUsers = snapshot.users || [];
    } catch (error) {
      state.page = 'rooms';
      state.roomId = null;
      showToast(error.message, 'error');
    }
  } else if (state.page === 'room-ended' && state.roomId && state.user) {
    try {
      const snapshot = await fetchJson(`/api/rooms/${encodeURIComponent(state.roomId)}`);
      state.endedRoom = snapshot.room;
    } catch (error) {
      state.page = 'rooms';
      state.roomId = null;
      showToast(error.message, 'error');
    }
  }
}

async function boot() {
  readLocation();
  appEl.innerHTML = '<div class="loading-state">Getting your people together…</div>';
  document.addEventListener('click', handleClick);
  appEl.addEventListener('submit', handleSubmit);
  appEl.addEventListener('input', handleInput);
  window.addEventListener('hashchange', () => {
    const previousPage = state.page;
    const previousRoomId = state.roomId;
    readLocation();
    if (previousPage === 'watch' && (state.page !== 'watch' || state.roomId !== previousRoomId)) closeCurrentRoomConnection();
    renderTopbar();
    renderApp();
    if (state.page === 'watch' && state.roomId && state.user) connectRoomSocket(state.roomId);
    if (state.page === 'community') refreshLeaderboard(state.leaderboardPeriod);
    if (state.page === 'events') refreshEvents();
  });
  await loadInitial();
  renderTopbar();
  renderApp();
  if (state.page === 'watch' && state.roomId && state.user) connectRoomSocket(state.roomId);
  if (state.page === 'community') { refreshLeaderboard(state.leaderboardPeriod); refreshCommunityMissions(); }
  if (state.page === 'events') refreshEvents();
  window.clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer = window.setInterval(refreshLiveHome, 30000);
  window.clearInterval(state.roomRefreshTimer);
  state.roomRefreshTimer = window.setInterval(() => {
    if (state.page === 'home' || state.page === 'rooms') refreshRooms();
  }, 4000);
}

boot();
