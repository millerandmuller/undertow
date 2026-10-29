import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { restoreBaseline } from '../src/actuator/settings.ts';
import { deviceLogin, validateToken, refreshTokens, REQUIRED_SCOPES } from '../src/auth/auth.ts';
import { ChatSender } from '../src/chat/send.ts';
import { isLoginFailure } from '../src/run.ts';
import { Helix } from '../src/util/helix.ts';
import { REQUEST_TIMEOUT_MS } from '../src/util/http.ts';
import { baselineSettings, validTokens } from './helpers/fixtures.ts';

test('refresh 400 and 401 are login failures without matching unrelated error bodies', () => {
  for (const status of [400, 401]) {
    assert.equal(isLoginFailure(`Token refresh failed (${status})`), true);
  }
  assert.equal(isLoginFailure('Helix request failed (400): body says 401'), false);
  assert.equal(isLoginFailure('unrelated Token refresh failed (400) text'), false);
});

test('auth, Helix, and chat requests carry injectable request timeouts', async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 10_000);
  const signals: AbortSignal[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return new Response(JSON.stringify({
      user_id: '42', login: 'streamer', scopes: REQUIRED_SCOPES,
      ...validTokens,
    }));
  };
  await validateToken('access', 'client', 'streamer', fetcher, REQUIRED_SCOPES, 5);
  await refreshTokens(validTokens, 'client', async () => undefined, fetcher, undefined, 5);
  const helix = new Helix('client', validTokens, async () => undefined, {
    fetcher, requestTimeoutMs: 5,
  });
  await helix.request('chat/settings');
  const sender = new ChatSender({
    request: async (_path: string, init?: RequestInit) => {
      assert.ok(init?.signal);
      signals.push(init.signal);
      return { data: [{ is_sent: true, message_id: 'reply', drop_reason: null }] };
    },
  } as Helix, '42', { requestTimeoutMs: 5 });
  await sender.send('A kind notice.');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signals.length, 4);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('corrupt, empty, null, and empty-object baselines have a clear file error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-invalid-baseline-'));
  const path = join(directory, 'baseline.json');
  try {
    for (const text of ['{broken', '', 'null', '{}']) {
      await writeFile(path, text);
      await assert.rejects(restoreBaseline({
        get: async () => baselineSettings,
        update: async () => assert.fail('invalid baseline must not be sent'),
      }, path), /baseline.json is unreadable: fix or delete it/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('device grant requests and polling use the shared injectable timeout', async () => {
  const signals: AbortSignal[] = [];
  await deviceLogin('client', 'streamer', async () => undefined, {
    requestTimeoutMs: 5,
    sleep: async () => undefined,
    fetcher: async (input, init) => {
      assert.ok(init?.signal);
      signals.push(init.signal);
      const url = String(input);
      if (url.endsWith('/device')) {
        return new Response(JSON.stringify({
          device_code: 'test-code', user_code: 'test-user-code',
          verification_uri: 'https://example.test', expires_in: 60, interval: 1,
        }));
      }
      return new Response(JSON.stringify(url.endsWith('/validate')
        ? { user_id: '42', login: 'streamer', scopes: REQUIRED_SCOPES }
        : validTokens));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
});
