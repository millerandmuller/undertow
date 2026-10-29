import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { baselineSettings } from './helpers/fixtures.ts';
import { FakeSocket } from './helpers/fakes.ts';
import { loadConfig } from '../src/config.ts';
import { startRun, type RunClock } from '../src/run.ts';
import type { Helix } from '../src/util/helix.ts';

class SimulatedClock implements RunClock {
  timeMs = 0;
  callback: (() => Promise<void>) | null = null;

  now(): number {
    return this.timeMs;
  }

  every(_intervalMs: number, callback: () => Promise<void>): () => void {
    this.callback = callback;
    return () => { this.callback = null; };
  }

  async seconds(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      this.timeMs += 1000;
      await this.callback?.();
    }
  }
}

async function openRun(options: {
  directory: string;
  dryRun: boolean;
  verbose?: boolean;
  clock?: SimulatedClock;
  logs: unknown[];
  methods: string[];
  requests?: { path: string; body: Record<string, unknown> }[];
  delay?: (milliseconds: number) => Promise<void>;
  existingBaseline?: boolean;
}) {
  FakeSocket.reset();
  if (options.existingBaseline) {
    await writeFile(join(options.directory, 'baseline.json'),
      JSON.stringify(baselineSettings));
  }
  let settings = { ...baselineSettings };
  let sentIndex = 0;
  let patchFailures = 0;
  let patchError: string | null = null;
  const helix = {
    remaining: '100',
    limit: '800',
    request: async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      options.methods.push(`${method} ${path}`);
      if (path === 'chat/messages') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        options.requests?.push({ path, body });
        return {
          data: [{
            is_sent: true,
            drop_reason: null,
            message_id: `undertow-${sentIndex++}`,
          }],
        };
      }
      if (path.startsWith('chat/settings') && method === 'PATCH') {
        if (patchError) {
          const message = patchError;
          patchError = null;
          throw new Error(message);
        }
        if (patchFailures > 0) {
          patchFailures -= 1;
          throw new Error('temporary PATCH failure');
        }
        settings = { ...settings, ...JSON.parse(String(init.body)) };
        return { data: [] };
      }
      if (path.startsWith('chat/settings')) return { data: [{ ...settings }] };
      return { data: [] };
    },
  } as Helix;
  const clock = options.clock ?? new SimulatedClock();
  const starting = startRun({
    helix,
    broadcasterId: '42',
    profile: await loadConfig('real'),
    stateDirectory: options.directory,
    dryRun: options.dryRun,
    verbose: options.verbose,
    socketConstructor: FakeSocket,
    clock,
    delay: options.delay,
    log: (entry) => options.logs.push(entry),
  });
  let startError: unknown;
  void starting.catch((error: unknown) => { startError = error; });
  while (FakeSocket.instances.length === 0 && startError === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (startError !== undefined) throw startError;
  FakeSocket.instances[0].sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'run-session', keepalive_timeout_seconds: 60 } },
  });
  return {
    handle: await starting,
    clock,
    socket: FakeSocket.instances[0],
    methods: options.methods,
    get settings() { return { ...settings }; },
    setSettings(next: typeof settings) { settings = { ...next }; },
    failPatches(count: number) { patchFailures = count; },
    failNextPatchWith(message: string) { patchError = message; },
  };
}

function rawChatEvent(id: string, chatterId = '9'): unknown {
  return {
    metadata: { message_type: 'notification', message_id: `event-${id}` },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '42',
        chatter_user_id: chatterId,
        message_id: id,
        message: { text: 'hello' },
      },
    },
  };
}

async function withLiveRun(
  callback: (run: Awaited<ReturnType<typeof openRun>>, requests:
    { path: string; body: Record<string, unknown> }[], logs: unknown[],
    directory: string) => Promise<void>,
  delay?: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-threading-'));
  const logs: unknown[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const run = await openRun({
    directory,
    dryRun: false,
    logs,
    methods: [],
    requests,
    delay,
  });
  try {
    await callback(run, requests, logs, directory);
  } finally {
    await run.handle.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test('reply threading follows the latest foreign message, not our own echo', async () => {
  await withLiveRun(async (run, requests, _logs, directory) => {
    await sendEvent(run, rawChatEvent('viewer-1'));
    await sendEvent(run, raidEvent('raid-1'));
    assert.equal(requests[0].body.reply_parent_message_id, 'viewer-1');

    await run.clock.seconds(3);
    await sendEvent(run, rawChatEvent('undertow-0', '42'));
    await sendEvent(run, raidEvent('raid-2'));
    assert.equal('reply_parent_message_id' in requests[1].body, false);
    const stormLines = (await readFile(join(directory, 'storm.log.jsonl'), 'utf8'))
      .trim().split('\n');
    assert.equal(JSON.parse(stormLines.at(-1) ?? '{}').reply_id, null);

    await run.clock.seconds(3);
    await sendEvent(run, rawChatEvent('viewer-2'));
    await sendEvent(run, raidEvent('raid-3'));
    assert.equal(requests[2].body.reply_parent_message_id, 'viewer-2');
  });
});

test('a hand-typed broadcaster message remains a valid reply parent', async () => {
  await withLiveRun(async (run, requests) => {
    await sendEvent(run, rawChatEvent('broadcaster-hand-typed', '42'));
    await sendEvent(run, raidEvent('raid-hand-typed'));
    assert.equal(
      requests[0].body.reply_parent_message_id,
      'broadcaster-hand-typed',
    );
  });
});

test('sent message id memory stays bounded to the latest 20 ids', async () => {
  await withLiveRun(async (run, requests) => {
    await sendEvent(run, rawChatEvent('viewer-start'));
    for (let index = 0; index < 21; index++) {
      await sendEvent(run, raidEvent(`raid-${index}`));
      await run.clock.seconds(3);
    }
    await sendEvent(run, rawChatEvent('undertow-0', '42'));
    await sendEvent(run, raidEvent('raid-after-eviction'));
    assert.equal(requests.length, 22);
    assert.equal(
      requests[21].body.reply_parent_message_id,
      'undertow-0',
    );
  });
});

test('manual settings at baseline are kept without a PATCH', async () => {
  await withLiveRun(async (run) => {
    run.setSettings({ ...baselineSettings, slow_mode: true, slow_mode_wait_time: 60 });
    await sendEvent(run, settingsEvent('manual-at-zero', {
      slow_mode: true,
      slow_mode_wait_time_seconds: 60,
    }));
    await run.handle.stop();
    assert.equal(run.settings.slow_mode, true);
    assert.equal(run.settings.slow_mode_wait_time, 60);
    assert.equal(run.methods.filter((entry) => entry.startsWith('PATCH ')).length, 0);
  });
});

test('live start refuses a saved baseline while dry start ignores it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-baseline-start-'));
  const logs: unknown[] = [];
  try {
    await assert.rejects(openRun({
      directory,
      dryRun: false,
      logs,
      methods: [],
      existingBaseline: true,
    }), /unrestored previous run/);
    const dry = await openRun({
      directory,
      dryRun: true,
      logs,
      methods: [],
      existingBaseline: true,
    });
    await dry.handle.stop();
    assert.equal(JSON.parse(await readFile(join(directory, 'baseline.json'), 'utf8'))
      .slow_mode, baselineSettings.slow_mode);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manual settings after controller changes remain untouched on exit', async () => {
  await withLiveRun(async (run, _requests, logs) => {
    let messageId = 0;
    let sawFirstStep = false;
    for (let second = 0; second < 70; second += 1) {
      for (let count = 0; count < 7; count += 1) {
        run.socket.sendMessage(rawChatEvent(`pace-${messageId++}`));
      }
      await flushEvents();
      await run.clock.seconds(1);
      const patchCount = run.methods.filter((entry) => entry.startsWith('PATCH ')).length;
      if (patchCount === 1 && !sawFirstStep) {
        sawFirstStep = true;
        await sendEvent(run, settingsEvent('own-slow-3', {
          slow_mode: true,
          slow_mode_wait_time_seconds: 3,
        }));
        assert.equal(logs.some((entry) => typeof entry === 'object' && entry !== null &&
          'type' in entry && entry.type === 'manual_settings_change'), false);
      }
      if (patchCount >= 2) break;
    }
    assert.equal(run.methods.filter((entry) => entry.startsWith('PATCH ')).length, 2);
    run.setSettings({ ...run.settings, slow_mode: true, slow_mode_wait_time: 60 });
    await sendEvent(run, settingsEvent('manual-after-step-two', {
      slow_mode: true,
      slow_mode_wait_time_seconds: 60,
    }));
    await run.handle.stop();
    assert.equal(run.methods.filter((entry) => entry.startsWith('PATCH ')).length, 2);
    assert.equal(run.settings.slow_mode_wait_time, 60);
  });
});

test('a controller-owned step is restored on exit', async () => {
  await withLiveRun(async (run) => {
    let messageId = 0;
    for (let second = 0; second < 30; second += 1) {
      for (let count = 0; count < 7; count += 1) {
        run.socket.sendMessage(rawChatEvent(`exit-pace-${messageId++}`));
      }
      await flushEvents();
      await run.clock.seconds(1);
      if (run.methods.filter((entry) => entry.startsWith('PATCH ')).length > 0) break;
    }
    assert.equal(run.settings.slow_mode, true);
    await run.handle.stop();
    assert.equal(run.settings.slow_mode, baselineSettings.slow_mode);
    assert.equal(run.methods.filter((entry) => entry.startsWith('PATCH ')).length, 2);
  });
});

test('restore retries with backoff and reports a final failure loudly', async () => {
  const delays: number[] = [];
  await withLiveRun(async (run, _requests, _logs, directory) => {
    let messageId = 0;
    for (let second = 0; second < 30; second += 1) {
      for (let count = 0; count < 7; count += 1) {
        run.socket.sendMessage(rawChatEvent(`retry-pace-${messageId++}`));
      }
      await flushEvents();
      await run.clock.seconds(1);
      if (run.methods.filter((entry) => entry.startsWith('PATCH ')).length > 0) break;
    }
    run.failPatches(1);
    await run.handle.stop();
    assert.deepEqual(delays, [1000]);
    assert.equal(run.handle.exitCode, 0);
    await assert.rejects(readFile(join(directory, 'baseline.json'), 'utf8'));
  }, async (milliseconds) => { delays.push(milliseconds); });
});

test('failed restore stays loud, exits nonzero, and keeps baseline for restore command',
  async () => {
    const delays: number[] = [];
    await withLiveRun(async (run, _requests, logs, directory) => {
      let messageId = 0;
      for (let second = 0; second < 30; second += 1) {
        for (let count = 0; count < 7; count += 1) {
          run.socket.sendMessage(rawChatEvent(`failed-restore-${messageId++}`));
        }
        await flushEvents();
        await run.clock.seconds(1);
        if (run.methods.filter((entry) => entry.startsWith('PATCH ')).length > 0) break;
      }
      run.failPatches(10);
      await run.handle.stop();
      assert.deepEqual(delays, [1000, 2000, 4000]);
      assert.equal(run.handle.exitCode, 1);
      assert.ok(logs.includes('RESTORE FAILED: run npm run restore now'));
      assert.ok(JSON.parse(await readFile(join(directory, 'baseline.json'), 'utf8')));
    }, async (milliseconds) => { delays.push(milliseconds); });
  });

test('a 400 body containing 401 does not pause the controller', async () => {
  await withLiveRun(async (run, _requests, logs) => {
    await driveToFirstStep(run, 'bad-request');
    run.failNextPatchWith('Helix request failed (400): body contains 401');
    for (let second = 0; second < 5; second += 1) {
      for (let count = 0; count < 7; count += 1) {
        run.socket.sendMessage(rawChatEvent(`bad-request-more-${second}-${count}`));
      }
      await flushEvents();
      await run.clock.seconds(1);
    }
    assert.equal(logs.some((entry) => typeof entry === 'object' && entry !== null &&
      'type' in entry && entry.type === 'login_needed'), false);
  });
});

test('a real 401 pauses and resumes after a later successful refresh', async () => {
  await withLiveRun(async (run, _requests, logs) => {
    await driveToFirstStep(run, 'expired-token');
    run.failNextPatchWith('Helix request failed (401): Unauthorized');
    for (let second = 0; second < 25; second += 1) {
      for (let count = 0; count < 7; count += 1) {
        run.socket.sendMessage(rawChatEvent(`expired-more-${second}-${count}`));
      }
      await flushEvents();
      await run.clock.seconds(1);
      if (logs.some((entry) => typeof entry === 'object' && entry !== null &&
        'type' in entry && entry.type === 'login_needed')) break;
    }
    assert.ok(logs.some((entry) => typeof entry === 'object' && entry !== null &&
      'type' in entry && entry.type === 'login_needed'));
    await run.clock.seconds(60);
    assert.ok(logs.some((entry) => typeof entry === 'object' && entry !== null &&
      'type' in entry && entry.type === 'login_resumed'));
  });
});

async function driveToFirstStep(
  run: Awaited<ReturnType<typeof openRun>>,
  prefix: string,
): Promise<void> {
  let messageId = 0;
  for (let second = 0; second < 30; second += 1) {
    for (let count = 0; count < 7; count += 1) {
      run.socket.sendMessage(rawChatEvent(`${prefix}-${messageId++}`));
    }
    await flushEvents();
    await run.clock.seconds(1);
    if (run.methods.filter((entry) => entry.startsWith('PATCH ')).length > 0) return;
  }
  throw new Error('Controller did not reach its first step');
}

function raidEvent(id: string): unknown {
  return {
    metadata: { message_type: 'notification', message_id: `event-${id}` },
    payload: {
      subscription: { type: 'channel.raid' },
      event: {
        from_broadcaster_user_id: '9',
        to_broadcaster_user_id: '42',
        viewers: 4,
      },
    },
  };
}

function settingsEvent(id: string, values: Record<string, unknown>): unknown {
  return {
    metadata: { message_type: 'notification', message_id: `event-${id}` },
    payload: {
      subscription: { type: 'channel.chat_settings.update' },
      event: { broadcaster_user_id: '42', ...values },
    },
  };
}

async function sendEvent(
  run: Awaited<ReturnType<typeof openRun>>,
  event: unknown,
): Promise<void> {
  run.socket.sendMessage(event);
  await flushEvents();
}

async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('run prints one status line per window in dry and live modes', async () => {
  for (const dryRun of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'undertow-status-'));
    const logs: unknown[] = [];
    const methods: string[] = [];
    let run: Awaited<ReturnType<typeof openRun>> | undefined;
    try {
      run = await openRun({ directory, dryRun, logs, methods });
      await run.clock.seconds(9);
      for (let index = 1; index <= 4; index++) {
        run.socket.sendMessage(rawChatEvent(String(index)));
      }
      await flushEvents();
      await run.clock.seconds(1);
      assert.equal(logs.filter((entry) => typeof entry === 'string').length, 1);
      await run.clock.seconds(9);
      for (let index = 5; index <= 8; index++) {
        run.socket.sendMessage(rawChatEvent(String(index)));
      }
      await flushEvents();
      await run.clock.seconds(1);
      const statuses = logs.filter((entry): entry is string => typeof entry === 'string');
      if (dryRun) assert.doesNotMatch(JSON.stringify(logs), /modeled/);
      assert.equal(run.handle.display.mode, dryRun ? 'dry' : 'live');
      assert.equal(run.handle.display.stepLabel, 'normal');
      assert.equal(run.handle.display.stepCount, 5);
      assert.equal(run.handle.display.warning, null);
      assert.equal(run.handle.display.ratelimitRemaining, 100);
      assert.equal(run.handle.display.ratelimitLimit, 800);
      assert.equal(run.handle.display.paceSource, 'measured');
      assert.deepEqual(statuses, [
        `pace 0.4/s, setpoint 6/s, step 0 of 5 (${dryRun ? 'dry' : 'live'})`,
        `pace 0.4/s, setpoint 6/s, step 0 of 5 (${dryRun ? 'dry' : 'live'})`,
      ]);
      assert.equal(methods.filter((entry) => entry.startsWith('PATCH ')).length, 0);
    } finally {
      await run?.handle.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('status line shows a warning only while its hold is active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-warning-status-'));
  const logs: unknown[] = [];
  const methods: string[] = [];
  try {
    const run = await openRun({ directory, dryRun: true, logs, methods });
    run.socket.sendMessage({
      metadata: { message_type: 'notification', message_id: 'gift-id' },
      payload: {
        subscription: { type: 'channel.chat.notification' },
        event: { broadcaster_user_id: '42', chatter_user_id: '42', notice_type: 'sub_gift' },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await run.clock.seconds(40);
    const statuses = logs.filter((entry): entry is string => typeof entry === 'string');
    assert.equal(statuses.length, 4);
    assert.match(statuses[0], /^warning: gift,/);
    assert.match(statuses[1], /^warning: gift,/);
    assert.equal(statuses[2].startsWith('warning:'), false);
    assert.equal(statuses[3].startsWith('warning:'), false);
    await run.handle.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('run raw EventSub output is verbose-only and connection problems remain visible',
  async () => {
    for (const verbose of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), 'undertow-verbose-'));
      const logs: unknown[] = [];
      const methods: string[] = [];
      try {
        const run = await openRun({ directory, dryRun: true, verbose, logs, methods });
        run.socket.sendMessage(rawChatEvent('sample'));
        await new Promise((resolve) => setImmediate(resolve));
        const rawEvents = logs.filter((entry) => typeof entry === 'object' &&
          entry !== null && 'message_id' in entry);
        assert.equal(rawEvents.length, verbose ? 1 : 0);
        await run.handle.stop();
        assert.ok(logs.some((entry) => typeof entry === 'object' && entry !== null &&
          'code' in entry));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

test('dry run writes decision records without changing settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-dry-run-'));
  const logs: unknown[] = [];
  const methods: string[] = [];
  try {
    const run = await openRun({ directory, dryRun: true, logs, methods });
    await run.clock.seconds(1);
    await run.handle.stop();
    const lines = (await readFile(join(directory, 'storm.log.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(JSON.parse(lines[0]).action, 'dry_none');
    assert.equal(JSON.parse(lines[0]).pace_source, 'recorded');
    assert.equal(methods.some((method) => method.startsWith('PATCH ')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
