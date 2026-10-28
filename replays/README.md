# Replay fixtures

`gift-wave.jsonl` is a synthetic, deterministic three-minute storm. The EventSub
field shapes match the real message and notice event shapes used by Undertow.
Viewer identities, raid details, timing, and message volumes are invented; the
volumes model a calm start, a raid and gift warning, a ramp to about 6 messages
per second, a plateau, and a return to calm. Regenerate it with
`node scripts/make-storm.mjs`.
