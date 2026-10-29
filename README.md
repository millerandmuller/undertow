# Undertow

Chat pace, held steady by Twitch's own dials, and explained to everyone in one sentence.

Work in progress. Built for the Codex x TwitchCon Hackathon (October 23 to November 2, 2026).

## Run Undertow

Use Node 25.4+ (native fetch, WebSocket, and TypeScript type stripping). Copy
`.env.example` to `.env`, set `TWITCH_CLIENT_ID` and `TWITCH_CHANNEL_LOGIN`, then
use the npm scripts below.
They load `.env` automatically; clones without the file can still run commands such as
`npm run probe` to see its plan. For Confidential Twitch apps, also set
`TWITCH_CLIENT_SECRET`; it is used only when refreshing tokens.

- `npm run login` — authenticate through Twitch device login and save `.undertow/tokens.json`.
- `npm run login -- --account <login>` — add a plain team account for load testing.
- `npm run probe -- --yes` — save a baseline, briefly set slow mode to 10
  seconds, then restore and verify. Without `--yes`, prints the plan only.
- `npm run watch -- --seconds 30` — listen to EventSub for 30 seconds by
  default and print event types.
- `npm run restore` — restore and verify saved chat settings.
- `npm test` — run local tests.


## Run the pace controller

`node src/cli.ts run` starts the controller in dry mode. It listens to EventSub,
calculates chat pace, and writes JSON lines to `.undertow/storm.log.jsonl` without
changing settings or replying. Add `--live` to apply the ladder and send threaded
notices; live mode always saves and restores the channel baseline on exit. Pass
`--verbose` to print raw EventSub notifications; connection and error events always
remain visible. You can
also pass `--dry` explicitly. `UNDERTOW_STATE_DIR` selects another directory for
tokens, baseline, and logs, which is useful for isolated runs.

Choose `real` (default) or `loadtest` with `--profile real` / `--profile loadtest`,
or set `UNDERTOW_PROFILE`. `undertow.config.json` defines both profiles. The
ladder steps are slow mode at 3, 10, and 30 seconds, followers-only for 10 minutes,
then emote-only. The controller moves one step at a time after sustained high pace;
it releases one step at a time after pace stays below the release threshold.

| Profile | Setpoint | Window | Dwell | Release hold |
| --- | ---: | ---: | ---: | ---: |
| real | 6 msgs/s | 10 s | 20 s | 30 s |
| loadtest | 2 msgs/s | 10 s | 15 s | 30 s |

The loadtest dwell is deliberately 15 s: on camera a step every 8 s looks like
panic.

A gift or raid temporarily lowers the effective setpoint. If a channel settings
update does not match Undertow's last patch, Undertow restores its baseline and
yields to the streamer for the configured manual override hold.

## Replay a storm

`npm run replay -- replays/gift-wave.jsonl --profile loadtest --runs 3` runs the
recording through Undertow's controller and run loop using an in-memory channel
and simulated clock. Replay needs no `.env`, token, or network connection. It prints
an honesty banner, decisions, summary metrics, and whether repeated runs matched.
`--runs N` repeats from a fresh simulated channel; `--tail N` changes the default
90 second release tail. The shipped storm is synthetic; see `replays/README.md`.
Synthetic files use `--model on` by default; pass `--model off` for an open-loop
replay. Recorded real files default to `--model off` and remain open loop. Modeled
paces are labeled `modeled` and the banner names the synthetic assumption file;
unmodified input rates are labeled `recorded`. The model exists to test controller
behavior, not to estimate real impact. The only impact number shown in the demo
comes from the live load test.
The last run's decisions are written to `.undertow/replay.last.jsonl`, or to the
folder set by `UNDERTOW_STATE_DIR`.

Add `--record path.jsonl` to `run` to record the four supported EventSub event
types for later replay. Recorded files have `synthetic:false`. Chat display text
is replaced with its character count; event ids, notice types, and required
payload fields remain available to reproduce controller behavior.

## Needle overlay for OBS

The overlay is a local browser source, served only on `127.0.0.1`. Start a dry
controller with `node src/cli.ts run --overlay 8787`, or use `--overlay` alone to
select port 8787. Open `http://127.0.0.1:8787/` as an OBS Browser Source and set
its width to 560 and height to 300. Add `?scale=1.5` to enlarge the card. The
server closes with the run loop.

For replay, use `node src/cli.ts replay replays/gift-wave.jsonl --profile loadtest
--overlay 8787 --speed 20`. With an overlay, replay defaults to real time at
`--speed 1`; `--speed 20` runs twenty times faster and `--speed max` is instant.
Without an overlay, replay defaults to instant speed. Overlay replay supports one
run only because each paced run needs its own open browser connection.

The overlay labels live run pace as measured. Replay's dashed `SIMULATION` card
shows the prominent simulation badge; when response modeling is on, its pace is
labeled `modeled` and is a synthetic assumption, not a measurement. The only
impact number shown in the demo comes from the live load test; modeled numbers are
for testing controller behavior. A grey card and `reconnecting` reason indicate a
lost local connection.

## Labeled load test

Create one account file per plain Twitch account owned by the team. Sign in to
that account in a browser, run `npm run login -- --account <login>`, then enter
the device code at `twitch.tv/activate`. Each account needs only
`user:write:chat`; it should be a plain account with no moderator role. The
broadcaster account is refused as a sender.

Run the controller separately with `node src/cli.ts run --live --profile loadtest`.
Then run `npm run loadtest -- --rate 0.5 --burst 90 --taper 30`. The load test
always targets `TWITCH_CHANNEL_LOGIN`, caps each account at 0.6 messages per
second and at 18 attempts per rolling 30 seconds, and prefixes every scripted
line with `[load test] `. The committed neutral lines are in
`loadtest/lines.txt`. Start with `--dry` to print the account and rate plan
without sending messages. Account count comes from the account files present.

The summary reports accepted and dropped messages and observed rates from the
actual send responses. It does not estimate impact. Load test state and
message records are written to `.undertow/loadtest.state.json` and
`.undertow/loadtest.log.jsonl`; the run loop uses the active state for the
overlay badge. Account tokens are stored separately in `.undertow/accounts/`.
