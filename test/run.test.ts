import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { baselineSettings } from './helpers/fixtures.ts';
import { FakeSocket } from './helpers/fakes.ts';
import { loadConfig } from '../src/config.ts';
import { startRun } from '../src/run.ts';
import type { Helix } from '../src/util/helix.ts';

test('dry run logs decisions without PATCH requests or replies', async () => {
  FakeSocket.reset();
  const directory = await mkdtemp(join(tmpdir(), 'undertow-run-'));
  const methods: string[] = [];
  const helix = {
    remaining: '100',
    request: async (path: string, init?: RequestInit) => {
      methods.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.startsWith('chat/settings')) return { data: [{ ...baselineSettings }] };
      return { data: [] };
    },
  } as Helix;
  try {
    const starting = startRun({
      helix,
      broadcasterId: '42',
      profile: await loadConfig('loadtest'),
      stateDirectory: directory,
      dryRun: true,
      socketConstructor: FakeSocket,
      log: () => undefined,
    });
    while (FakeSocket.instances.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    FakeSocket.instances[0].sendMessage({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'dry-session', keepalive_timeout_seconds: 30 } },
    });
    const handle = await starting;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await handle.stop();
    await handle.done;
    const lines = (await readFile(join(directory, 'storm.log.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).action, 'dry_none');
    assert.equal(methods.some((method) => method.startsWith('PATCH ')), false);
    assert.equal(methods.filter((method) => method.includes('eventsub/subscriptions')).length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
