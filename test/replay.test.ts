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
  loadResponseModel,
  messagePassesModel,
  parseResponseModel,
} from '../src/sim/response-model.ts';
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

function windowRate(events: number[], start: number, end: number): number {
  const count = events.filter((time) => time > start && time <= end).length;
  return count / ((end - start) / 1000);
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

test('shipped storm model lowers response, climbs, restores, and is deterministic', async () => {
  const replay = await loadReplay('replays/gift-wave.jsonl');
  const profile = await loadConfig('loadtest');
  const model = await loadResponseModel();
  const directory = await temporaryDirectory();
  try {
    const runs = [];
    for (let index = 0; index < 3; index += 1) {
      runs.push(await runReplay(replay, profile, join(directory, `run-${index}`), 90,
        undefined, model));
    }
    const openLoop = await runReplay(replay, profile, join(directory, 'open-loop'));
    assert.deepEqual(runs[0].decisions, runs[1].decisions);
    assert.deepEqual(runs[1].decisions, runs[2].decisions);
    const moves = runs[0].decisions.filter((item) =>
      item.action === 'step_up' || item.action === 'step_down' || item.action === 'restore');
    const ups = moves.filter((item) => item.action === 'step_up');
    assert.ok(ups.length >= 3);
    assert.equal(runs[0].modeled, true);
    const lastUp = ups.at(-1);
    assert.ok(lastUp);
    const postStepPace = windowRate(
      runs[0].simulatedMessageOffsets,
      lastUp.offset_ms,
      lastUp.offset_ms + profile.window_s * 1000,
    );
    const openLoopUps = openLoop.decisions.filter((item) => item.action === 'step_up');
    const openLoopLastUp = openLoopUps.at(-1);
    assert.ok(openLoopLastUp);
    const openLoopPace = windowRate(
      openLoop.recordedMessageOffsets,
      openLoopLastUp.offset_ms,
      openLoopLastUp.offset_ms + profile.window_s * 1000,
    );
    assert.ok(postStepPace < openLoopPace);
    const topStep = runs[0].decisions.find((item) => item.action === 'step_up' && item.step === 5);
    assert.ok(!topStep || topStep.pace > profile.setpoint_msgs_per_s);
    assert.equal(moves.at(-1)?.action, 'restore');
    for (let index = 1; index < moves.length; index += 1) {
      assert.ok(moves[index].offset_ms - moves[index - 1].offset_ms >=
        profile.dwell_s * 1000);
    }
    assert.ok(runs[0].replies.length >= ups.length + 1);
    assert.ok(runs[0].replies.every((reply) => reply.parent_id !== null));
    assert.ok(runs[0].replies.some((reply) => reply.message.includes('raid is landing')));
    assert.ok(runs[0].replies.some((reply) => reply.message.includes('gift wave is landing')));
    assert.equal(runs[0].finalSettings.slow_mode, baseline.slow_mode);
    assert.equal(runs[0].finalSettings.follower_mode, baseline.follower_mode);
    assert.equal(runs[0].finalSettings.emote_mode, baseline.emote_mode);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('response model validates one bounded fraction per ladder level', async () => {
  const model = await loadResponseModel();
  assert.deepEqual(model.pass_through_by_step, [1, 0.85, 0.6, 0.35, 0.25, 0.15]);
  assert.throws(() => parseResponseModel({
    ...model,
    pass_through_by_step: [1, 0.85, 0.6, 0.35, 0.25],
  }), /one fraction/);
  assert.throws(() => parseResponseModel({
    ...model,
    pass_through_by_step: [1, 0.85, 0.6, 1.1, 0.25, 0.15],
  }), /from 0 to 1/);
  assert.equal(messagePassesModel(1234, 42, 0.6), messagePassesModel(1234, 42, 0.6));
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
  const model = await loadResponseModel();
  const directory = await temporaryDirectory();
  try {
    const regular = await runReplay(
      replay, profile, join(directory, 'regular'), 90, undefined, model,
    );
    const reconnected = await runReplay(
      replay,
      profile,
      join(directory, 'reconnected'),
      90,
      40_000,
      model,
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

test('replay output labels modeled and recorded rates and needs no credentials', async () => {
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
    assert.match(result.stdout, /RESPONSE MODEL: synthetic assumption, not measured/);
    const rateSummary = result.stdout.split('\n').filter((line) =>
      /pace|msgs\/s/.test(line));
    assert.ok(rateSummary.length >= 3);
    assert.ok(rateSummary.every((line) => /modeled|recorded/.test(line)));
    assert.ok(result.stdout.includes('modeled pace after the last step-up'));
    const savedDecisions = await readFile(join(directory, 'replay.last.jsonl'), 'utf8');
    assert.match(savedDecisions, /"pace_source":"modeled"/);
    assert.match(savedDecisions, /msgs\/s \(modeled\)/);

    const openLoop = spawnSync(process.execPath, [
      'src/cli.ts', 'replay', 'replays/gift-wave.jsonl', '--profile', 'loadtest',
      '--runs', '1', '--model', 'off',
    ], {
      env: { PATH: process.env.PATH ?? '', UNDERTOW_STATE_DIR: directory },
      encoding: 'utf8',
    });
    assert.equal(openLoop.status, 0, openLoop.stderr);
    const openSummary = openLoop.stdout.split('\n').filter((line) =>
      /pace|msgs\/s/.test(line));
    assert.ok(openSummary.every((line) => /recorded/.test(line)));

    const recordedPath = join(directory, 'recorded.jsonl');
    const syntheticReplay = await loadReplay('replays/gift-wave.jsonl');
    const { writeReplay } = await import('../src/sim/replay.ts');
    await writeReplay(recordedPath, {
      ...syntheticReplay,
      header: { ...syntheticReplay.header, synthetic: false },
    });
    const recordedOutput = spawnSync(process.execPath, [
      'src/cli.ts', 'replay', recordedPath, '--profile', 'loadtest', '--runs', '1',
    ], {
      env: { PATH: process.env.PATH ?? '', UNDERTOW_STATE_DIR: directory },
      encoding: 'utf8',
    });
    assert.equal(recordedOutput.status, 0, recordedOutput.stderr);
    assert.match(recordedOutput.stdout, /RECORDED STREAM: open loop/);
    assert.doesNotMatch(recordedOutput.stdout, /RESPONSE MODEL:/);
    assert.ok(recordedOutput.stdout.split('\n')
      .filter((line) => /pace|msgs\/s/.test(line))
      .every((line) => /recorded/.test(line)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
