# Undertow

Chat pace, held steady by Twitch's own dials, and explained to everyone in one sentence.

Work in progress. Built for the Codex x TwitchCon Hackathon (October 23 to November 2, 2026).

## Run Undertow

Use Node 25.4+ (native fetch, WebSocket, and TypeScript type stripping). Copy `.env.example` to `.env`, set `TWITCH_CLIENT_ID` and `TWITCH_CHANNEL_LOGIN`, then run:

- `npm run login` — authenticate through Twitch device login and save `.undertow/tokens.json`.
- `npm run probe -- --yes` — save a baseline, briefly set slow mode to 10 seconds, then restore and verify. Without `--yes`, prints the plan only.
- `npm run watch -- --seconds 30` — listen to EventSub for 30 seconds by default and print event types.
- `npm run restore` — restore and verify saved chat settings.
- `npm test` — run local tests.
