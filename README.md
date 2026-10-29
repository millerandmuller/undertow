# Undertow

## What it does (30 seconds)

Undertow listens to Twitch chat over EventSub and adjusts Twitch's own chat
settings as the first closed-loop controller for chat pace on Twitch. The real
profile setpoint is 6 messages per second, measured over a 10-second window.
When pace stays above the setpoint for 20 seconds, it steps up one rung; it
holds each rung for at least 20 seconds. It steps down one rung after pace stays
below 3 messages per second for 30 seconds. Between 3 and 6 messages per second,
hysteresis keeps the current setting in place.
`sustain_ratio` defaults to 0.8, so at least 80 percent of one-second readings
in the dwell must exceed the effective setpoint; release still requires every
reading to remain below its threshold.

1. Slow mode 3 s lets each viewer post once every 3 seconds, a light first pause
   when chat starts running faster than the setpoint.
2. Slow mode 10 s lets each viewer post once every 10 seconds, giving chat more
   space when the first pause has not brought the pace down.
3. Slow mode 30 s lets each viewer post once every 30 seconds, slowing the flow
   when the shorter pauses have not been enough.
4. Followers-only 10 min lets only viewers who followed at least 10 minutes ago
   post, limiting fresh follows when the three slow mode rungs have not helped.
5. Emote-only allows messages made only of emotes, keeping chat to reactions
   when followers-only has not brought the pace down.

A step up needs pace above the setpoint for 20 s and the current rung held for
20 s; a step down needs pace below half the setpoint for 30 s, one rung at a time
without skipping.

Each change replies to the latest message from someone else, or is unthreaded
when the latest message was Undertow's own reply. For example: “Slow mode 10 s:
chat hit 14 msgs/s. Back to normal when
it drops under 3 msgs/s for 30 s.” The streamer's own manual change always
wins: Undertow yields without undoing the change and leaves that setting alone
on exit. It saves the baseline before changing settings and restores only
settings it still owns. If restore fails after retries, it prints
`RESTORE FAILED: run npm run restore now` and exits with an error. A live start
with a saved baseline prints
`unrestored previous run: run npm run restore first` and exits.

## Quick start without credentials

After making a fresh copy of the repository, run the shipped synthetic storm
with its local overlay:

```sh
npm run replay -- replays/gift-wave.jsonl --profile loadtest --overlay 0 --speed 20
```

This replay is a simulation with no Twitch connection. Its response model is a
synthetic assumption, so every before-and-after pace produced by the model is
labeled “modeled”. The overlay URL is printed when the local server starts.

## Run scripts

The repository has no `run` script. Start the run loop with
`node --env-file-if-exists=.env src/cli.ts run`; dry mode is the default.

| Command | What it does |
| --- | --- |
| `npm run login` | Sign in to the broadcaster account with a device code. |
| `npm run probe` | Print the safe probe plan; add `-- --yes` to briefly change and restore settings. |
| `npm run watch` | Print EventSub event types; add `-- --seconds N` to set its duration. |
| `node --env-file-if-exists=.env src/cli.ts run --dry` | Run without setting changes or replies; add `--profile real` or `--profile loadtest`, `--verbose`, `--overlay [port]`, or `--record <file>`. |
| `node --env-file-if-exists=.env src/cli.ts run --live` | Apply settings and send threaded replies; the same `--profile`, `--verbose`, `--overlay`, and `--record` flags are available. |
| `npm run loadtest` | Show the load-test plan; add `-- --dry` to preview or `-- --rate`, `-- --burst`, `-- --taper`, and `-- --accounts` to set its inputs. |
| `npm run replay` | Replay a scenario; pass a file, `--profile`, `--runs`, `--model`, `--overlay`, `--speed`, or `--tail`. |
| `npm run report` | Create or view a post-storm report; add `-- --profile`, `-- --scenario`, `-- --saved`, or `-- --accept`. |

`UNDERTOW_STATE_DIR` selects the directory for tokens, baselines, storm logs,
and other state files. `UNDERTOW_CONFIG_PATH` selects a config file for report
review and acceptance. The `--profile` flag selects `real` or `loadtest`; the
default is `real`. `--verbose` shows raw EventSub notifications. `--record`
stores replayable events with chat text replaced by its character count. Replay
is instant without an overlay; with an overlay, use `--speed N` to pace it or
`--speed max` for instant playback. `--runs N` repeats an unpaced replay and
checks that the decisions match.
Run `npm run restore` to reapply the saved baseline. For a 30-second event
window, use `npm run watch -- --seconds 30`.

## Environment

Copy `.env.example` to `.env` and fill its values locally. `.env` is ignored and
never committed.

| Variable | Purpose |
| --- | --- |
| `TWITCH_CLIENT_ID` | Identifies the Twitch application. |
| `TWITCH_CHANNEL_LOGIN` | Names the broadcaster channel Undertow may control. |
| `TWITCH_CLIENT_SECRET` | Used only when refreshing tokens for a confidential application. |

## Limits

| Area | Limit | What the code does |
| --- | --- | --- |
| Twitch chat | 20 messages per 30 seconds per plain user. | The load test caps attempts at 18 per rolling 30 seconds and rejects rates above 0.6 per second. |
| Helix | 800 points per minute per client. | This budget is not hard-coded; the wrapper reads `Ratelimit-*`, waits for a 429 reset, then retries once. |
| EventSub | Cost 0 for `channel.chat.message`, `channel.chat.notification`, `channel.chat_settings.update`, and `channel.raid`. | The client subscribes to these four version 1 events. It does not hard-code subscription costs. |
| User token | About 3.6 hours. | The token response supplies its lifetime. At startup, a validation 401 triggers one refresh using the confidential app secret, if configured. |
| Chat settings and replies | Slow mode 3 to 120 seconds; followers-only 0 to 129600 minutes; chat message at most 500 characters. | The actuator validates both bounds and the sender rejects longer messages. |

## What is the load test

The planned test uses up to eight labeled plain accounts owned by the team on
the team's test channel. The broadcaster is always `TWITCH_CHANNEL_LOGIN`;
account files for that broadcaster are refused. The command uses whichever
account files exist, and each sends neutral scripted lines with the visible
`[load test] ` prefix. The `loadtest` profile has a scaled setpoint of 1.5 messages
per second instead of 6 and a release level of 0.75 messages per second.

Create one account file per sender: sign in to that account, run
`npm run login -- --account <login>`, and enter the code at `twitch.tv/activate`.
Each sender is a plain team account with `user:write:chat` permission and no
moderator role. `--rate` sets messages per second per account up to 0.6;
`--burst` sets the full-rate duration; `--taper` sets the linear fade duration.
An internal rolling limiter permits at most 18 sends per account in 30 seconds.
The overlay badge reads `load test, N accounts` while the test is active.

The summary reports attempted, accepted, and dropped sends and observed accepted
rates. Its before-and-after pace is a scaled test result, not a claim about real
channels. A real-channel run measures chat and never prints a modeled number.
Start the controller with
`node --env-file-if-exists=.env src/cli.ts run --live --profile loadtest`, then
run `npm run loadtest -- --rate 0.5 --burst 90 --taper 30`. The test writes
`.undertow/loadtest.state.json` and
`.undertow/loadtest.log.jsonl`.

## The post-storm report

`npm run report` gives Codex a copy of the storm log and profile settings in an
isolated scratch directory. Codex proposes thresholds; the replay simulator
scores the proposal; config changes only with `--accept` after a passing score
and a matching log. If Codex is unavailable, the last saved report is the
fallback. Reading labels (`recorded` or `modeled`) come from the storm log.
`--saved` skips Codex and scores the last saved report. `UNDERTOW_CONFIG_PATH`
can point acceptance at a scratch config. Proposal output does not change the
config by itself.
For example, `npm run report -- --profile loadtest --scenario replays/gift-wave.jsonl`
selects the profile and scenario.

## Built with Codex

Codex wrote all code in this repository; the human directed the work, reviewed
each change, ran it against Twitch, and committed. The whole build continued in
the single Codex thread `01a17fa0-44a2-7081-b2bc-68084379eebb`. The working
rules are in `AGENTS.md`; build evidence and the commit list are in
`docs/BUILD_EVIDENCE.md`.

## Layout and tests

- `src/auth`, `src/eventsub`, `src/actuator`: sign-in, event listening, and
  Twitch chat settings.
- `src/controller`, `src/run.ts`, `src/chat`: pace decisions, the run loop, and
  threaded replies.
- `src/sim`, `replays`: labeled replay simulation and synthetic storm data.
- `src/overlay`: local display server and page.
- `src/loadtest`, `loadtest`: account sender and neutral message lines.
- `src/report`, `docs`: proposal scoring and build evidence.
- `test`: automated tests with local fakes.

Run `npm test` for the test suite and `npm run check` for source style checks.
