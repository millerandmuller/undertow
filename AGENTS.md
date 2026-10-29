# Undertow working rules

- Never print secrets, tokens, device codes after use, or `.env` contents.
- Restore channel chat settings on exit after any change.
- Keep any future pace controller free of I/O.
- Run `npm test` before committing.
- The controller stays pure: no I/O, timers, or clock reads.
- Simulated pieces live in `src/sim` and are labeled.
- Modeled numbers live only in `src/sim` and are always labeled modeled.
- Load test messages always carry the [load test] prefix.
- Codex proposes, the simulator scores, a human accepts.
- On stream, never show a token, a client secret, a device code or `.env` contents
  on screen or in a log line, and never run the load test against a channel the team does not own.
