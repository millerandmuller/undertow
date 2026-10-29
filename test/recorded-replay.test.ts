import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatSettings } from '../src/actuator/settings.ts';
import { loadConfig } from '../src/config.ts';
import { startRun } from '../src/run.ts';
import { SimulatedChannel } from '../src/sim/channel.ts';
import { SimulatedClock } from '../src/sim/clock.ts';
import { SimulatedSettingsPlayback } from '../src/sim/settings-playback.ts';
import { runReplay, type ReplayResult } from '../src/sim/driver.ts';
import { parseReplay, type ReplayEvent, type ReplayFile } from '../src/sim/replay.ts';
import {
  emitSimulatedEvent, resetSimulatedSockets, SimulatedSocketConstructor,
} from '../src/sim/socket.ts';
import type { Helix } from '../src/util/helix.ts';
import { baselineSettings } from './helpers/fixtures.ts';

function rawHeader() {
  return {
    kind: 'header', version: 1, label: 'synthetic recorded-stream test',
    synthetic: false, broadcaster_id: '42',
    baseline: { ...baselineSettings, slow_mode_wait_time: null, follower_mode_duration: null },
  };
}

function parseEvents(events: ReplayEvent[]): ReplayFile {
  return parseReplay([JSON.stringify(rawHeader()), ...events.map(JSON.stringify)].join('\n'));
}

function recordedBurst(): ReplayFile {
  const events: ReplayEvent[] = [];
  for (let index = 0; index < 270; index += 1) {
    events.push({
      kind: 'event', at_ms: Math.floor(index * 1000 / 6), type: 'channel.chat.message',
      event: {
        broadcaster_user_id: '42', chatter_user_id: '9', message_id: `recorded-${index}`,
        message: { text: '<5 chars>' },
      },
    });
  }
  events.push({
    kind: 'event', at_ms: 3000, type: 'channel.chat.notification',
    event: { broadcaster_user_id: '42', chatter_user_id: '9', notice_type: 'sub_gift' },
  });
  events.sort((left, right) => left.at_ms - right.at_ms);
  return parseEvents(events);
}

function fullSettings(settings: ChatSettings) {
  const { slow_mode_wait_time, follower_mode_duration, ...modes } = settings;
  return {
    broadcaster_user_id: '42', ...modes,
    slow_mode_wait_time_seconds: settings.slow_mode ? slow_mode_wait_time : null,
    follower_mode_duration_minutes: settings.follower_mode ? follower_mode_duration : null,
  };
}

function withEchoes(base: ReplayFile, result: ReplayResult, marked: boolean, shift: number) {
  const moves = result.decisions.filter((item) =>
    ['step_up', 'step_down', 'restore'].includes(item.action));
  assert.equal(result.patches.length, moves.length);
  let settings = { ...base.header.baseline };
  const events = [...base.events];
  for (const [index, move] of moves.entries()) {
    settings = { ...settings, ...result.patches[index] };
    const item: ReplayEvent = {
      kind: 'event', at_ms: move.offset_ms + shift, type: 'channel.chat_settings.update',
      event: fullSettings(settings),
    };
    if (marked) item.own_echo = true;
    events.push(item);
  }
  events.sort((left, right) => left.at_ms - right.at_ms);
  return parseEvents(events);
}

async function inDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-recorded-replay-'));
  try {
    await callback(directory);
  } finally {
    resetSimulatedSockets();
    await rm(directory, { recursive: true, force: true });
  }
}

function manualChanges(logs: unknown[]): unknown[] {
  return logs.filter((entry) => typeof entry === 'object' && entry !== null &&
    'type' in entry && entry.type === 'manual_settings_change');
}

test('null baselines normalize while invalid duration values are rejected', () => {
  const parsed = parseEvents([]);
  assert.equal(parsed.header.baseline.slow_mode_wait_time, 0);
  assert.equal(parsed.header.baseline.follower_mode_duration, 0);
  for (const field of ['slow_mode_wait_time', 'follower_mode_duration']) {
    for (const value of ['10', -1]) {
      const header = rawHeader();
      assert.throws(() => parseReplay(JSON.stringify({
        ...header, baseline: { ...header.baseline, [field]: value },
      })), /finite number at least 0/);
    }
    const text = JSON.stringify(rawHeader()).replace(`"${field}":null`, `"${field}":NaN`);
    assert.throws(() => parseReplay(text), /invalid replay header/);
    const infinite = JSON.stringify(rawHeader()).replace(`"${field}":null`, `"${field}":1e400`);
    assert.throws(() => parseReplay(infinite), /finite number at least 0/);
  }
});

test('replay own_echo accepts only boolean values when present', () => {
  const event: ReplayEvent = {
    kind: 'event', at_ms: 0, type: 'channel.chat_settings.update',
    event: { broadcaster_user_id: '42', slow_mode: false },
  };
  for (const own_echo of [true, false]) {
    assert.equal(parseEvents([{ ...event, own_echo }]).events[0].own_echo, own_echo);
  }
  for (const own_echo of ['true', null, 1]) {
    assert.throws(() => parseReplay(JSON.stringify(rawHeader()) + '\n' +
      JSON.stringify({ ...event, own_echo })), /own_echo must be boolean/);
  }
});

test('simulated recorded settings accept both duration spellings and null', () => {
  const channel = new SimulatedChannel(baselineSettings);
  channel.applyRecordedSettings({
    broadcaster_user_id: '42', slow_mode_wait_time: 10, follower_mode_duration: 5,
  });
  assert.equal(channel.settings.slow_mode_wait_time, 10);
  assert.equal(channel.settings.follower_mode_duration, 5);
  channel.applyRecordedSettings({
    broadcaster_user_id: '42', slow_mode_wait_time_seconds: null,
    follower_mode_duration_minutes: null,
  });
  assert.equal(channel.settings.slow_mode_wait_time, 0);
  assert.equal(channel.settings.follower_mode_duration, 0);
  channel.applyRecordedSettings({
    broadcaster_user_id: '42', slow_mode_wait_time_seconds: 30,
    follower_mode_duration_minutes: 10,
  });
  assert.equal(channel.settings.slow_mode_wait_time, 30);
  assert.equal(channel.settings.follower_mode_duration, 10);
  channel.applyRecordedSettings({
    broadcaster_user_id: '42', slow_mode_wait_time: null, follower_mode_duration: null,
  });
  assert.equal(channel.settings.slow_mode_wait_time, 0);
  assert.equal(channel.settings.follower_mode_duration, 0);
});

test('recorder normalizes null baselines and marks recognized own echoes before round-trip',
  async () => {
    await inDirectory(async (directory) => {
      resetSimulatedSockets();
      const recordPath = join(directory, 'recorded.jsonl');
      const helix = {
        remaining: null,
        request: async (path: string) => path.startsWith('chat/settings')
          ? { data: [rawHeader().baseline] } : { data: [] },
      } as Helix;
      const run = await startRun({
        helix, broadcasterId: '42', profile: await loadConfig('loadtest'),
        stateDirectory: join(directory, 'state'), dryRun: true, recordPath,
        clock: new SimulatedClock(), socketConstructor: SimulatedSocketConstructor,
        log: () => undefined,
      });
      emitSimulatedEvent({
        type: 'channel.chat_settings.update', message_id: 'own-recorded',
        event: fullSettings(baselineSettings),
      });
      emitSimulatedEvent({
        type: 'channel.chat_settings.update', message_id: 'manual-recorded',
        event: { broadcaster_user_id: '42', emote_mode: true },
      });
      await run.stop();
      const text = await readFile(recordPath, 'utf8');
      const replay = parseReplay(text);
      assert.deepEqual(replay.header.baseline, baselineSettings);
      assert.equal(replay.events[0].own_echo, true);
      assert.equal(replay.events[1].own_echo, false);
      assert.doesNotMatch(text.split('\n')[0], /:null/);
    });
  });

test('recorded burst with marked or legacy echoes before and after PATCHes steps and restores',
  async () => {
    await inDirectory(async (directory) => {
      const profile = await loadConfig('loadtest');
      const base = recordedBurst();
      const reference = await runReplay(base, profile, join(directory, 'reference'));
      for (const marked of [true, false]) {
        for (const shift of [-3000, 3000]) {
          const replay = withEchoes(base, reference, marked, shift);
          const logs: unknown[] = [];
          const result = await runReplay(replay, profile,
            join(directory, `${marked}-${shift}`), 90, undefined, null, {
              log: (entry) => logs.push(entry),
            });
          assert.ok(result.decisions.some((item) => item.action === 'step_up'));
          assert.equal(result.decisions.some((item) => item.action === 'yield'), false);
          assert.equal(manualChanges(logs).length, 0);
          assert.equal(result.finalSettings.slow_mode, false);
          assert.equal(result.finalSettings.follower_mode, false);
          assert.equal(result.finalSettings.emote_mode, false);
        }
      }
    });
  });

test('an unmatched recorded settings change still plays as a manual override', async () => {
  await inDirectory(async (directory) => {
    const profile = await loadConfig('loadtest');
    const base = recordedBurst();
    const reference = await runReplay(base, profile, join(directory, 'reference'));
    for (const ownEcho of [undefined, false]) {
      const replay = withEchoes(base, reference, false, 3000);
      const atMs = replay.events.at(-1)!.at_ms + 5000;
      const manual: ReplayEvent = {
        kind: 'event', at_ms: atMs, type: 'channel.chat_settings.update',
        event: { broadcaster_user_id: '42', emote_mode: true },
      };
      if (ownEcho !== undefined) manual.own_echo = ownEcho;
      replay.events.push(manual);
      const logs: unknown[] = [];
      const result = await runReplay(replay, profile, join(directory, `manual-${ownEcho}`),
        90, undefined, null, { log: (entry) => logs.push(entry) });
      assert.ok(result.decisions.some((item) => item.action === 'yield'));
      assert.equal(manualChanges(logs).length, 1);
      assert.equal(result.finalSettings.emote_mode, true);
      const changed = manualChanges(logs)[0] as { override_until_ms: number };
      const delayMs = ownEcho === false ? 0 : 3000;
      assert.equal(changed.override_until_ms, atMs + delayMs + profile.override_hold_s * 1000);
    }
  });
});

test('marked echoes apply when needed and never roll back a newer simulated change', async () => {
  resetSimulatedSockets();
  let nowMs = 0;
  const channel = new SimulatedChannel(baselineSettings, () => nowMs);
  const playback = new SimulatedSettingsPlayback(channel);
  const original = fullSettings({ ...baselineSettings, slow_mode: true, slow_mode_wait_time: 3 });
  const event: ReplayEvent = {
    kind: 'event', at_ms: 0, type: 'channel.chat_settings.update', own_echo: true,
    event: original,
  };
  playback.accept(event, 0);
  assert.equal(channel.settings.slow_mode_wait_time, 3);
  assert.equal(channel.patches.length, 0);
  const helix = channel.createHelix();
  await helix.request('chat/settings', {
    method: 'PATCH', body: JSON.stringify({ slow_mode: true, slow_mode_wait_time: 3 }),
  });
  nowMs = 1000;
  await helix.request('chat/settings', {
    method: 'PATCH', body: JSON.stringify({ slow_mode: true, slow_mode_wait_time: 10 }),
  });
  assert.equal(channel.matchesRecordedChange(original, 3000), true);
  assert.equal(channel.matchesRecordedChange(original, 3001), false);
  playback.accept({ ...event, at_ms: 60_000 }, 1);
  assert.equal(channel.settings.slow_mode_wait_time, 10);
});

test('a live fake-driven recording marks actual controller PATCH echoes', async () => {
  await inDirectory(async (directory) => {
    resetSimulatedSockets();
    const clock = new SimulatedClock();
    const channel = new SimulatedChannel(baselineSettings, () => clock.now());
    const recordPath = join(directory, 'actual-echoes.jsonl');
    const profile = {
      ...await loadConfig('loadtest'), dwell_s: 2, window_s: 1, setpoint_msgs_per_s: 0.5,
    };
    const run = await startRun({
      helix: channel.createHelix(), broadcasterId: '42', profile,
      stateDirectory: join(directory, 'state'), dryRun: false, recordPath,
      clock, socketConstructor: SimulatedSocketConstructor, log: () => undefined,
    });
    try {
      for (let second = 0; second < 6 && channel.patches.length === 0; second += 1) {
        await clock.advanceTo(second * 1000 + 500);
        for (let index = 0; index < 2; index += 1) {
          const id = `actual-${second}-${index}`;
          emitSimulatedEvent({
            type: 'channel.chat.message', message_id: id,
            event: {
              broadcaster_user_id: '42', chatter_user_id: '9', message_id: id,
              message: { text: 'test message' },
            },
          });
        }
        await waitForRecordedLines(recordPath, (second + 1) * 2 + 1);
        await clock.advanceTo((second + 1) * 1000);
      }
      assert.ok(channel.patches.length > 0);
    } finally {
      await run.stop();
    }
    const recorded = parseReplay(await readFile(recordPath, 'utf8'));
    const echoes = recorded.events.filter((event) => event.type === 'channel.chat_settings.update');
    assert.ok(echoes.length > 0);
    assert.ok(echoes.every((event) => event.own_echo === true));
  });
});


async function waitForRecordedLines(path: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(path, 'utf8');
    if ((text.match(/\n/g) ?? []).length >= count) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Recorder did not finish writing the expected events');
}
