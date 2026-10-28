# Undertow

Chat pace, held steady by Twitch's own dials, and explained to everyone in one sentence.

Work in progress. Built for the Codex x TwitchCon Hackathon (October 23 to November 2, 2026).

## Run Undertow

Use Node 25.4+ (native fetch, WebSocket, and TypeScript type stripping). Copy `.env.example` to `.env`, set `TWITCH_CLIENT_ID` and `TWITCH_CHANNEL_LOGIN`, then use the npm scripts below.
They load `.env` automatically; clones without the file can still run commands such as
`npm run probe` to see its plan. For Confidential Twitch apps, also set
`TWITCH_CLIENT_SECRET`; it is used only when refreshing tokens.

- `npm run login` — authenticate through Twitch device login and save `.undertow/tokens.json`.
- `npm run probe -- --yes` — save a baseline, briefly set slow mode to 10 seconds, then restore and verify. Without `--yes`, prints the plan only.
- `npm run watch -- --seconds 30` — listen to EventSub for 30 seconds by default and print event types.
- `npm run restore` — restore and verify saved chat settings.
- `npm test` — run local tests.


## Run the pace controller

`node src/cli.ts run` starts the controller in dry mode. It listens to EventSub,
calculates chat pace, and writes JSON lines to `.undertow/storm.log.jsonl` without
changing settings or replying. Add `--live` to apply the ladder and send threaded
notices; live mode always saves and restores the channel baseline on exit. You can
also pass `--dry` explicitly. `UNDERTOW_STATE_DIR` selects another directory for
tokens, baseline, and logs, which is useful for isolated runs.

Choose `real` (default) or `loadtest` with `--profile real` / `--profile loadtest`,
or set `UNDERTOW_PROFILE`. `undertow.config.json` defines both profiles. The
ladder steps are slow mode at 3, 10, and 30 seconds, followers-only for 10 minutes,
then emote-only. The controller moves one step at a time after sustained high pace;
it releases one step at a time after pace stays below the release threshold.

A gift or raid temporarily lowers the effective setpoint. If a channel settings
update does not match Undertow's last patch, Undertow restores its baseline and
yields to the streamer for the configured manual override hold.
