'use strict';

const REQUIRED_PRODUCTION_VARIABLES = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'SESSION_SECRET',
  'DATABASE_URL',
];

function productionConfigErrors(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];

  const errors = REQUIRED_PRODUCTION_VARIABLES
    .filter((name) => !String(env[name] || '').trim())
    .map((name) => `${name} is required in production.`);

  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
    errors.push('SESSION_SECRET must contain at least 32 characters.');
  }

  if (env.DISCORD_REDIRECT_URI) {
    try {
      if (new URL(env.DISCORD_REDIRECT_URI).protocol !== 'https:') {
        errors.push('DISCORD_REDIRECT_URI must use HTTPS in production.');
      }
    } catch {
      errors.push('DISCORD_REDIRECT_URI must be an absolute URL.');
    }
  }

  if (env.DATABASE_URL && !/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
    errors.push('DATABASE_URL must point to PostgreSQL in production.');
  }

  for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID']) {
    if (env[name] && !/^\d{17,20}$/.test(env[name])) {
      errors.push(`${name} must be a Discord snowflake ID.`);
    }
  }

  return errors;
}

function assertProductionConfig(env = process.env) {
  const errors = productionConfigErrors(env);
  if (errors.length) {
    throw new Error(`Production configuration is incomplete:\n- ${errors.join('\n- ')}`);
  }
}

module.exports = { REQUIRED_PRODUCTION_VARIABLES, productionConfigErrors, assertProductionConfig };