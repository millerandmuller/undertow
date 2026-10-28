import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { ChatSettings } from '../src/actuator/settings.ts';
import { loadConfig } from '../src/config.ts';
import { loadReplay, parseReplay, type ReplayFile } from '../src/sim/replay.ts';
import { runReplay } from '../src/sim/driver.ts';
import { startRun } from '../src/run.ts';
import { SimulatedChannel } from '../src/sim/channel.ts';
import { SimulatedClock } from '../src/sim/clock.ts';
import {
  emitSimulatedEvent,
  resetSimulatedSockets,
  SimulatedSocketConstructor,
} from '../src/sim/socket.ts';

const baseline: ChatSettings = {
  slow_mode: false,
  slow_mode_wait_time: 30,
  follower_mode: false,
  follower_mode_duration: 0,
  emote_mode: false,
  subscriber_mode: false,
  unique_chat_mode: false,
};
const header = {
  kind: 'header' as const,
  version: 1 as const,
  label: 'test replay',
  synthetic: true,
  broadcaster_id: 'sim-broadcaster',
  baseline,
};

function chatEvent(id: string) {
  return {
    broadcaster_user_id: 'sim-broadcaster',
    chatter_user_id: 'sim-viewer',
    message_id: id,
    message: { text: 'hello' },
  };
}

function replayWithMessages(count: number, endMs: number): ReplayFile {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const at = Math.round(index * endMs / count);
    events.push({
      kind: 'event' as const,
      at_ms: at,
      type: 'channel.chat.message' as const,
      event: chatEvent(`message-${index}`),
    });
  }
  return { header, events };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'undertow-replay-'));
}

test('replay loader accepts a good file and writer output', async () => {
  const replay = replayWithMessages(1, 0);
  const parsed = parseReplay(`${JSON.stringify(header)}\n${JSON.stringify(replay.events[0])}\n`);
  assert.equal(parsed.events.length, 1);
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, 'good.jsonl');
    const { writeReplay } = await import('../src/sim/replay.ts');
    await writeReplay(path, replay);
    assert.deepEqual(await loadReplay(path), replay);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay loader rejects backwards offsets, unknown types, and missing headers', () => {
  const first = { ...replayWithMessages(1, 0).events[0], at_ms: 9 };
  const second = { ...first, at_ms: 8 };
  assert.throws(
    () => parseReplay(`${JSON.stringify(header)}\n${JSON.stringify(first)}\n` +
      `${JSON.stringify(second)}\n`),
    /must not go backwards/,
  );
  assert.throws(() => parseReplay(`${JSON.stringify(header)}\n` +
    `${JSON.stringify({ ...first, type: 'channel.unknown' })}\n`), /unknown replay event type/);
  assert.throws(() => parseReplay(JSON.stringify(first)), /version 1 header/);
});

test('shipped synthetic storm climbs, restores, replies, and is deterministic', async () => {
  const replay = await loadReplay('replays/gift-wave.jsonl');
  const profile = await loadConfig('loadtest');
  const directory = await temporaryDirectory();
  try {
    const runs = [];
    for (let index = 0; index < 3; index += 1) {
      runs.push(await runReplay(replay, profile, join(directory, `run-${index}`)));
    }
    assert.deepEqual(runs[0].decisions, runs[1].decisions);
    assert.deepEqual(runs[1].decisions, runs[2].decisions);
    const moves = runs[0].decisions.filter((item) =>
      item.action === 'step_up' || item.action === 'step_down' || item.action === 'restore');
    const ups = moves.filter((item) => item.action === 'step_up');
    assert.ok(ups.length >= 3);
    assert.equal(moves.at(-1)?.action, 'restore');
    for (let index = 1; index < moves.length; index += 1) {
      assert.ok(moves[index].offset_ms - moves[index - 1].offset_ms >=
        profile.dwell_s * 1000);
    }
    assert.ok(runs[0].replies.length >= ups.length + 1);
    assert.ok(runs[0].replies.every((reply) => reply.parent_id !== null));
    assert.equal(runs[0].finalSettings.slow_mode, baseline.slow_mode);
    assert.equal(runs[0].finalSettings.follower_mode, baseline.follower_mode);
    assert.equal(runs[0].finalSettings.emote_mode, baseline.emote_mode);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recorded manual override yields and sends no controller setting patches', async () => {
  const profile = await loadConfig('loadtest');
  const replay = replayWithMessages(80, 8000);
  replay.events.push({
    kind: 'event',
    at_ms: 9000,
    type: 'channel.chat_settings.update',
    event: { broadcaster_user_id: 'sim-broadcaster', follower_mode: true },
  });
  replay.events.sort((left, right) => left.at_ms - right.at_ms);
  const directory = await temporaryDirectory();
  try {
    const result = await runReplay(replay, profile, directory, 61);
    assert.ok(result.decisions.some((item) => item.action === 'yield'));
    assert.ok(result.patches.every((patch) => patch.slow_mode !== true));
    assert.ok(result.patches.every((patch) => patch.follower_mode !== true));
    assert.ok(result.patches.every((patch) => patch.emote_mode !== true));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('forced EventSub reconnect preserves replay decisions', async () => {
  const replay = await loadReplay('replays/gift-wave.jsonl');
  const profile = await loadConfig('loadtest');
  const directory = await temporaryDirectory();
  try {
    const regular = await runReplay(replay, profile, join(directory, 'regular'));
    const reconnected = await runReplay(
      replay,
      profile,
      join(directory, 'reconnected'),
      90,
      40_000,
    );
    assert.deepEqual(reconnected.decisions, regular.decisions);
  } finally {
    resetSimulatedSockets();
    await rm(directory, { recursive: true, force: true });
  }
});

test('run recording writes redacted replay events accepted by the loader', async () => {
  const directory = await temporaryDirectory();
  resetSimulatedSockets();
  try {
    const clock = new SimulatedClock();
    const channel = new SimulatedChannel(baseline);
    const recordPath = join(directory, 'captured.jsonl');
    const run = await startRun({
      helix: channel.createHelix(),
      broadcasterId: 'sim-broadcaster',
      profile: await loadConfig('loadtest'),
      stateDirectory: join(directory, 'state'),
      dryRun: true,
      recordPath,
      clock,
      socketConstructor: SimulatedSocketConstructor,
      log: () => undefined,
    });
    const captured = [
      {
        type: 'channel.chat.message',
        message_id: 'captured-message',
        event: { ...chatEvent('captured-message'), display_name: 'Invented display' },
      },
      {
        type: 'channel.chat.notification',
        message_id: 'captured-notice',
        event: {
          broadcaster_user_id: 'sim-broadcaster',
          chatter_user_id: 'sim-viewer',
          notice_type: 'sub_gift',
          display_name: 'Invented display',
        },
      },
      {
        type: 'channel.chat_settings.update',
        message_id: 'captured-settings',
        event: { broadcaster_user_id: 'sim-broadcaster', slow_mode: false },
      },
      {
        type: 'channel.raid',
        message_id: 'captured-raid',
        event: {
          from_broadcaster_user_id: 'sim-raider',
          to_broadcaster_user_id: 'sim-broadcaster',
          viewers: 12,
        },
      },
    ] as const;
    for (const event of captured) {
      emitSimulatedEvent(event as Parameters<typeof emitSimulatedEvent>[0]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run.stop();
    const recorded = await loadReplay(recordPath);
    const messageEvent = recorded.events[0].event as { message: { text: string } };
    assert.equal(recorded.header.synthetic, false);
    assert.equal(recorded.events.length, 4);
    assert.equal(messageEvent.message.text, '<5 chars>');
    const content = await readFile(recordPath, 'utf8');
    assert.doesNotMatch(content, /Invented display/);
    assert.match(content, /captured-message/);
    const replayed = await runReplay(
      recorded,
      await loadConfig('loadtest'),
      join(directory, 'recorded-replay'),
      1,
    );
    assert.equal(replayed.finalSettings.slow_mode, baseline.slow_mode);
  } finally {
    resetSimulatedSockets();
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay command needs no env credentials or tokens', async () => {
  const directory = await temporaryDirectory();
  try {
    const result = spawnSync(process.execPath, [
      'src/cli.ts', 'replay', 'replays/gift-wave.jsonl', '--profile', 'loadtest', '--runs', '1',
    ], {
      env: { PATH: process.env.PATH ?? '', UNDERTOW_STATE_DIR: directory },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith(
      'SIMULATION (replay of replays/gift-wave.jsonl, no Twitch connection)',
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
