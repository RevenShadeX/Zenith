'use strict';

const { Client, Events, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

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

function createDiscordBot({ token, guildId, onMessage, onReady, onError = console.error }) {
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

  return { client, getGuildMember, isGuildAdministrator, ready };
}

module.exports = { createDiscordBot, isTrackableMessage };