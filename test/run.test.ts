import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
}) {
  FakeSocket.reset();
  let settings = { ...baselineSettings };
  let sentIndex = 0;
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
    log: (entry) => options.logs.push(entry),
  });
  while (FakeSocket.instances.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  FakeSocket.instances[0].sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'run-session', keepalive_timeout_seconds: 60 } },
  });
  return { handle: await starting, clock, socket: FakeSocket.instances[0] };
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

async function sendEvent(
  run: Awaited<ReturnType<typeof openRun>>,
  event: unknown,
): Promise<void> {
  run.socket.sendMessage(event);
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
      await run.clock.seconds(1);
      assert.equal(logs.filter((entry) => typeof entry === 'string').length, 1);
      await run.clock.seconds(9);
      for (let index = 5; index <= 8; index++) {
        run.socket.sendMessage(rawChatEvent(String(index)));
      }
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
