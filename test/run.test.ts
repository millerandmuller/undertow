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
}) {
  FakeSocket.reset();
  let settings = { ...baselineSettings };
  const helix = {
    remaining: '100',
    request: async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      options.methods.push(`${method} ${path}`);
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

function rawChatEvent(id: string): unknown {
  return {
    metadata: { message_type: 'notification', message_id: `event-${id}` },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '42',
        chatter_user_id: '9',
        message_id: id,
        message: { text: 'hello' },
      },
    },
  };
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
    assert.equal(methods.some((method) => method.startsWith('PATCH ')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
