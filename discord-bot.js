'use strict';

const { Client, Events, GatewayIntentBits, PermissionFlagsBits, ApplicationCommandOptionType } = require('discord.js');

const COMMANDS = [
  {
    name: 'level',
    description: 'Show your Zenith level and XP',
  },
  {
    name: 'leaderboard',
    description: 'Show the Zenith XP leaderboard',
    options: [{
      name: 'period',
      description: 'Leaderboard period',
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: 'All time', value: 'all_time' },
        { name: 'This month', value: 'this_month' },
        { name: 'This week', value: 'this_week' },
        { name: 'Today', value: 'today' },
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

function createDiscordBot({ token, guildId, onMessage, onReady, onError = console.error, onLevel, onEventCommand }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
    ],
    allowedMentions: { parse: [] },
  });

  let guild = null;
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
      resolveReady(guild);
    } catch (error) {
      rejectReady(error);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (!isTrackableMessage(message, guildId)) return;
    Promise.resolve(onMessage(message)).catch(onError);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    Promise.resolve((async () => {
      if (interaction.commandName === 'level') {
        const data = await onLevel?.(interaction.user.id);
        if (!data) return interaction.reply({ content: 'Level data is unavailable right now.', ephemeral: true });
        return interaction.reply({
          content: `**${data.displayName}** — Level **${data.level}** · ${data.xp.toLocaleString()} XP · ${data.messages.toLocaleString()} messages`,
        });
      }

      if (interaction.commandName === 'leaderboard') {
        const period = interaction.options.getString('period') || 'all_time';
        const rows = await onLevel?.('leaderboard', period) || [];
        if (!rows.length) return interaction.reply({ content: 'No Zenith XP data yet.', ephemeral: true });
        const lines = rows.slice(0, 10).map((row, index) =>
          `**${index + 1}.** ${row.displayName} — Level ${row.level} · ${Number(row.xp).toLocaleString()} XP`);
        return interaction.reply({ content: `**Zenith XP Leaderboard — ${period.replace('_', ' ')}**\\n${lines.join('\\n')}` });
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
    })()).catch(onError);
  });

  client.on(Events.Error, onError);

  const ready = client.login(token).then(() => readyEvent).catch((error) => {
    rejectReady(error);
    throw error;
  });

  async function getGuildMember(discordUserId) {
    if (!guild) await ready;
    return guild.members.fetch(discordUserId);
  }

  async function isGuildAdministrator(discordUserId) {
    const member = await getGuildMember(discordUserId);
    return member.permissions.has(PermissionFlagsBits.Administrator)
      || member.permissions.has(PermissionFlagsBits.ManageGuild);
  }

  return { client, getGuildMember, isGuildAdministrator, ready, commands: COMMANDS };
}

module.exports = { createDiscordBot, isTrackableMessage };