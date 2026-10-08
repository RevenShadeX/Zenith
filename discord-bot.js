'use strict';

const { Client, Events, GatewayIntentBits, PermissionFlagsBits, ApplicationCommandOptionType, ChannelType } = require('discord.js');

const COMMANDS = [
  {
    name: 'level',
    description: 'Show your Zenith level and XP',
  },
  {
    name: 'leaderboard',
    description: 'Show a Zenith leaderboard',
    options: [
      { name: 'type', description: 'Leaderboard to show', type: ApplicationCommandOptionType.String, required: false, choices: [{ name: 'XP / activity', value: 'xp' }, { name: 'Study VC time', value: 'study_vc' }] },
      { name: 'period', description: 'Time period for the XP leaderboard', type: ApplicationCommandOptionType.String, required: false, choices: [{ name: 'Today', value: 'today' }, { name: 'This week', value: 'this_week' }, { name: 'This month', value: 'this_month' }] },
    ],
  },
  {
    name: 'set',
    description: 'Configure Zenith server settings',
    options: [{
      name: 'leaderboard',
      description: 'Configure a leaderboard',
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'type', description: 'Leaderboard to configure', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'Study VC', value: 'study_vc' }] },
        { name: 'channel', description: 'Voice channel to track as the study room', type: ApplicationCommandOptionType.Channel, required: true, channel_types: [ChannelType.GuildVoice, ChannelType.GuildStageVoice] },
      ],
    }],
  },
  {
    name: 'event',
    description: 'Manage Zenith community events',
    options: [
      {
        name: 'add',
        description: 'Add an event to the Zenith website calendar',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'title', description: 'Event title', type: ApplicationCommandOptionType.String, required: true, max_length: 100 },
          { name: 'start', description: 'Start time, e.g. 2026-10-20 20:00', type: ApplicationCommandOptionType.String, required: true, max_length: 40 },
          { name: 'end', description: 'End time, e.g. 2026-10-20 22:00', type: ApplicationCommandOptionType.String, required: false, max_length: 40 },
          { name: 'type', description: 'Event type', type: ApplicationCommandOptionType.String, required: false, max_length: 40 },
          { name: 'description', description: 'Short event description', type: ApplicationCommandOptionType.String, required: false, max_length: 500 },
        ],
      },
      {
        name: 'list',
        description: 'Show upcoming events on the Zenith calendar',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'cancel',
        description: 'Cancel an event created through Zenith',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'event_id', description: 'Zenith event ID', type: ApplicationCommandOptionType.String, required: true }],
      },
    ],
  },
];

function formatDiscordEventTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:F>`;
}

function isTrackableMessage(message, guildId) {
  return Boolean(
    message?.guildId === guildId
    && message?.author?.id
    && !message.author.bot
    && message?.id
    && message?.channelId
    && message?.createdAt instanceof Date
    && !Number.isNaN(message.createdAt.getTime())
  );
}

function createDiscordBot({ token, guildId, onMessage, onReady, onError = console.error, onLevel, onEventCommand, onLeaderboardConfig, onVoiceStateUpdate, onMemberJoin, onInviteCreate }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
    allowedMentions: { parse: [] },
  });

  let guild = null;
  const inviteState = new Map();
  const badgeRolePromises = new Map();

  async function syncBadgeRole(discordUserId, badge) {
    if (!guild || !badge?.name) return false;
    try {
      let role = guild.roles.cache.find((item) => item.name === badge.name);
      if (!role) role = await guild.roles.create({ name: badge.name, reason: 'Zenith badge' });
      const member = await guild.members.fetch(String(discordUserId));
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Zenith badge earned');
      return true;
    } catch (error) {
      onError(new Error('Badge sync failed: ' + error.message));
      return false;
    }
  }

  async function refreshInvites() {
    if (!guild) return;
    try {
      const invites = await guild.invites.fetch();
      inviteState.clear();
      for (const invite of invites.values()) {
        inviteState.set(invite.code, {
          uses: Number(invite.uses || 0),
          inviterId: invite.inviter?.id ? String(invite.inviter.id) : null,
        });
      }
    } catch (error) {
      onError(new Error(`Discord invite tracking unavailable: ${error.message}`));
    }
  }

  async function detectInviteForMember(member) {
    if (!guild || member.guild?.id !== guildId) return null;
    try {
      const invites = await guild.invites.fetch();
      let match = null;
      for (const invite of invites.values()) {
        const previous = inviteState.get(invite.code);
        const currentUses = Number(invite.uses || 0);
        const inviterId = invite.inviter?.id ? String(invite.inviter.id) : previous?.inviterId || null;
        if (previous && currentUses > previous.uses && inviterId) {
          if (!match || currentUses - previous.uses > match.delta) {
            match = { code: invite.code, inviterId, delta: currentUses - previous.uses };
          }
        }
        inviteState.set(invite.code, { uses: currentUses, inviterId });
      }
      return match;
    } catch (error) {
      onError(new Error(`Discord invite attribution failed: ${error.message}`));
      return null;
    }
  }
  let resolveReady;
  let rejectReady;
  const readyEvent = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      guild = await readyClient.guilds.fetch(guildId);
      try {
        await guild.commands.set(COMMANDS);
      } catch (error) {
        onError(new Error(`Discord slash-command registration failed: ${error.message}`));
      }
      await onReady?.(guild);
      await refreshInvites();
      resolveReady(guild);
    } catch (error) {
      rejectReady(error);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (!isTrackableMessage(message, guildId)) return;
    Promise.resolve(onMessage(message)).catch(onError);
  });

  client.on(Events.InviteCreate, (invite) => {
    if (invite.guild?.id !== guildId) return;
    inviteState.set(invite.code, {
      uses: Number(invite.uses || 0),
      inviterId: invite.inviter?.id ? String(invite.inviter.id) : null,
    });
    Promise.resolve(onInviteCreate?.(invite)).catch(onError);
  });

  client.on(Events.InviteDelete, (invite) => {
    if (invite.guild?.id !== guildId) return;
    inviteState.delete(invite.code);
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild?.id !== guildId || member.user?.bot) return;
    Promise.resolve(detectInviteForMember(member))
      .then((invite) => onMemberJoin?.(member, invite))
      .catch(onError);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (oldState.guild?.id !== guildId && newState.guild?.id !== guildId) return;
    Promise.resolve(onVoiceStateUpdate?.(oldState, newState)).catch(onError);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    Promise.resolve((async () => {
      if (interaction.commandName === 'level') {
        const data = await onLevel?.(interaction.user.id, interaction.user);
        if (!data) return interaction.reply({ content: 'Level data is unavailable right now.', ephemeral: true });
        return interaction.reply({
          content: `**${data.displayName}** — Level **${data.level}** · ${data.xp.toLocaleString()} XP · ${data.messages.toLocaleString()} messages`,
        });
      }

      if (interaction.commandName === 'leaderboard') {
        const type = interaction.options.getString('type') || 'xp';
        if (type === 'study_vc') {
          const rows = await onLevel?.('study_vc') || [];
          if (!rows.length) return interaction.reply({ content: 'No study VC time has been recorded yet.', ephemeral: true });
          const lines = rows.slice(0, 10).map((row, index) =>
            `**${index + 1}.** ${row.display_name || row.displayName} — **${row.duration}**`);
          return interaction.reply({ content: `**Zenith Study VC Leaderboard**\n${lines.join('\n')}` });
        }
        const period = interaction.options.getString('period') || 'this_month';
        const rows = await onLevel?.('leaderboard', period) || [];
        if (!rows.length) return interaction.reply({ content: 'No Zenith XP data yet.', ephemeral: true });
        const lines = rows.slice(0, 10).map((row, index) =>
          `**${index + 1}.** ${row.displayName} — Level ${row.level} · ${Number(row.xp).toLocaleString()} XP`);
        return interaction.reply({ content: `**Zenith XP Leaderboard — ${period.replace('_', ' ')}**\n${lines.join('\n')}` });
      }

      if (interaction.commandName === 'set') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
          && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: 'You need Manage Server or Administrator permission to configure Zenith.', ephemeral: true });
        }
        if (interaction.options.getSubcommand() === 'leaderboard') {
          const type = interaction.options.getString('type', true);
          const channel = interaction.options.getChannel('channel', true);
          return onLeaderboardConfig?.(interaction, type, channel);
        }
      }
      if (interaction.commandName === 'event') {
        const subcommand = interaction.options.getSubcommand();
        if ((subcommand === 'add' || subcommand === 'cancel')
          && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
          && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: 'You need Manage Server or Administrator permission to use this event command.', ephemeral: true });
        }
        return onEventCommand?.(interaction, subcommand);
      }
    })()).catch(async (error) => {
      onError(error);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: 'Zenith could not complete that command. Please try again.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Zenith could not complete that command. Please try again.', ephemeral: true });
        }
      } catch (replyError) {
        onError(replyError);
      }
    });
  });

  client.on(Events.Error, onError);

  const ready = client.login(token).then(() => readyEvent).catch((error) => {
    rejectReady(error);
    throw error;
  });

  async function getMemberCount() {
    if (!guild) await ready;
    return Number(guild.memberCount || 0);
  }

  async function getGuildMember(discordUserId) {
    if (!guild) await ready;
    return guild.members.fetch(discordUserId);
  }

  async function isGuildAdministrator(discordUserId) {
    const member = await getGuildMember(discordUserId);
    return member.permissions.has(PermissionFlagsBits.Administrator)
      || member.permissions.has(PermissionFlagsBits.ManageGuild);
  }

  async function isGuildOwner(discordUserId) {
    if (!guild) await ready;
    return guild?.ownerId === String(discordUserId);
  }

  return { client, getGuildMember, getMemberCount, isGuildAdministrator, isGuildOwner, syncBadgeRole, ready, commands: COMMANDS };
}

module.exports = { COMMANDS, createDiscordBot, isTrackableMessage };