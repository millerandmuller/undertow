import { mkdir, writeFile } from 'node:fs/promises';

let seed = 0x6d2b79f5;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = seed;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

const baseline = {
  slow_mode: false,
  slow_mode_wait_time: 30,
  follower_mode: false,
  follower_mode_duration: 0,
  emote_mode: false,
  subscriber_mode: false,
  unique_chat_mode: false,
};
const header = {
  kind: 'header',
  version: 1,
  label: 'Synthetic deterministic gift wave storm',
  synthetic: true,
  broadcaster_id: 'synthetic-broadcaster',
  baseline,
};
const events = [];
let sequence = 0;
function message(atMs) {
  events.push({
    kind: 'event',
    at_ms: Math.max(0, Math.round(atMs)),
    type: 'channel.chat.message',
    event: {
      broadcaster_user_id: 'synthetic-broadcaster',
      chatter_user_id: `synthetic-viewer-${sequence % 37}`,
      message_id: `synthetic-message-${sequence++}`,
      message: { text: 'synthetic chat message' },
    },
  });
}
function emitInterval(startMs, endMs, intervalAt) {
  let at = startMs;
  while (at < endMs) {
    message(at);
    at += intervalAt(at) + (random() - 0.5) * 24;
  }
}
function notice(atMs) {
  events.push({
    kind: 'event',
    at_ms: atMs,
    type: 'channel.chat.notification',
    event: {
      broadcaster_user_id: 'synthetic-broadcaster',
      chatter_user_id: 'synthetic-gifter',
      notice_type: 'sub_gift',
    },
  });
}

emitInterval(0, 10_000, () => 2000);
events.push({
  kind: 'event',
  at_ms: 12_000,
  type: 'channel.raid',
  event: {
    from_broadcaster_user_id: 'synthetic-raider',
    to_broadcaster_user_id: 'synthetic-broadcaster',
    viewers: 24,
  },
});
notice(18_000);
emitInterval(25_000, 35_000, (at) => 500 - ((at - 25_000) / 10_000) * 333);
emitInterval(35_000, 95_000, () => 167);
emitInterval(95_000, 110_000, (at) => 167 + ((at - 95_000) / 15_000) * 1833);
emitInterval(110_000, 180_000, () => 2000);
events.sort((left, right) => left.at_ms - right.at_ms);
await mkdir('replays', { recursive: true });
await writeFile(
  'replays/gift-wave.jsonl',
  `${[header, ...events].map((item) => JSON.stringify(item)).join('\n')}\n`,
);
