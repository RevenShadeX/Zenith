# Zenith

Zenith is a Discord-connected community application for watch parties, room chat, events, and activity leaderboards. It uses Discord OAuth for website identity and a Discord bot for server-message activity.

## Requirements

- Node.js 22 or newer
- PostgreSQL for production
- A Discord application and bot installed in the configured guild
- HTTPS and a stable public origin in production

SQLite is used only when running outside production without a PostgreSQL `DATABASE_URL`. There are no seeded users, demo accounts, or authentication fallbacks.

## Local Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Configure the Discord OAuth application and bot values below. For local OAuth, register `http://localhost:3000/auth/discord/callback` as a redirect URL.
4. Start the server with `npm start`, or use `npm run dev` while developing.
5. Run checks with `npm test`.

When Discord OAuth is not configured in development, the server still serves public pages and APIs, but `/auth/discord` returns `503`. It does not manufacture a user. Configure OAuth to sign in.

## Environment

Set these in the deployment environment, never in frontend code:

- `NODE_ENV=production`
- `PORT`
- `DATABASE_URL` – PostgreSQL connection URL
- `SESSION_SECRET` – at least 32 random characters
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` – exact HTTPS callback registered in the Discord application
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `PG_POOL_MAX` – optional PostgreSQL pool size

Production startup fails if any required Discord or database value is missing, if the callback is not HTTPS, if the session secret is too short, or if the database URL is not PostgreSQL. The session cookie is Secure, HttpOnly, SameSite=Lax, and sessions are stored in PostgreSQL.

## Discord Configuration

1. Create a Discord application and configure the OAuth redirect URI to match `DISCORD_REDIRECT_URI` exactly.
2. Enable the `Guild Members` privileged gateway intent for the bot. Zenith does not request message content; it only needs guild message events to count messages.
3. Invite the bot to the configured guild with access to the channels whose messages should be counted. Grant View Channel and Read Message History only where needed. The bot does not need to send messages.
4. Use the OAuth scopes `identify` and `guilds.members.read`. The callback verifies the Discord identity and membership in `DISCORD_GUILD_ID` before creating a session.
5. Keep `DISCORD_BOT_TOKEN` server-side. It is never included in HTML or API responses.

The website user key is the Discord snowflake `discord_user_id`; usernames are display attributes and can change. Administrator actions check the member's current Discord Administrator or Manage Server permission rather than a user-editable database flag.

## Message Activity and History

The leaderboard stores individual Discord message IDs, guild/channel IDs, author Discord IDs, and Discord timestamps. Duplicate gateway deliveries are ignored. The browser has no endpoint for submitting counts.

Zenith records messages observed after the bot's first successful connection. The displayed tracking start time comes from the server database. Historical Discord totals are not imported or included; the UI labels them separately as unavailable. Therefore `Today`, `This week`, `This month`, and `All time` mean tracked messages since bot installation, bounded to the selected UTC period.

## Watch Rooms

Room creation and joining require Discord authentication. The server owns host identity, membership, viewer presence, lock state, playback state, media changes, and room termination. WebSocket clients authenticate with the session cookie; every host control is checked against the room's stored Discord host ID. Playback, presence, and chat events are broadcast by the server.

Supported sources:

- Direct HTTPS video files ending in `.mp4`, `.webm`, or `.ogv`
- Public YouTube links through YouTube's official privacy-enhanced embed
- Vimeo links through Vimeo's official embed player

Other URLs are rejected with an actionable error. Zenith does not bypass DRM, login requirements, paywalls, hotlink protections, or access controls. Hosts must have permission to share the media. Browser autoplay policies may require a viewer to tap once; playback commands remain host-authoritative.

## Deployment

- Use a managed PostgreSQL database and set `DATABASE_URL` as a secret.
- Terminate TLS at the deployment platform or reverse proxy and preserve the HTTPS origin.
- Set the Discord callback to the deployed HTTPS URL.
- Keep one Zenith process per deployment unless sticky WebSocket routing and shared presence/pub-sub are added. The current room presence map is process-local.
- Back up PostgreSQL and rotate Discord/session credentials through the hosting provider.

Legacy SQLite development databases are migrated by Discord snowflake identity. Old local demo users are discarded; old `messages_sent` values are not copied into tracked Discord counts.

## Project Files

- `server.js` – default secure server launcher
- `production-server.js` – Express API, OAuth, sessions, bot integration, and WebSocket protocol
- `database.js` – PostgreSQL production and SQLite development schemas/migrations
- `discord-bot.js` / `discord-activity.js` – gateway listener and authoritative message ledger
- `media.js` – URL validation and provider classification
- `leaderboard.js` – UTC reporting windows
- `js/app.js` / `js/media-providers.js` – frontend views, room protocol, direct and embed players
- `css/style.css` – responsive Zenith interface

## Tests

`npm test` runs Node's built-in test suite for production configuration, media validation, SQLite identity migrations, Discord-message filtering/deduplication, and leaderboard period aggregation. Live Discord OAuth/bot behavior additionally requires valid application credentials and the configured guild permissions.