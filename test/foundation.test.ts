import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  probeWithRestore,
  restoreBaseline,
  saveBaseline,
  validatePatch,
} from '../src/actuator/settings.ts';
import { deviceLogin, refreshTokens, validateToken } from '../src/auth/auth.ts';
import { EventSub } from '../src/eventsub/client.ts';
import { Helix } from '../src/util/helix.ts';
import { FakeSocket, jsonResponse } from './helpers/fakes.ts';
import { baselineSettings, validTokens } from './helpers/fixtures.ts';

const requiredScopes = validTokens.scope;
const identity = { user_id: '42', login: 'streamer', scopes: requiredScopes };
const validateResponse = () => jsonResponse(identity);

function deviceFetcher(outcomes: string[]): typeof fetch {
  let poll = 0;
  return (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/device')) {
      return jsonResponse({
        device_code: 'private-device-code',
        user_code: 'private-user-code',
        verification_uri: 'https://example.test',
        expires_in: 30,
        interval: 1,
      });
    }
    if (url.endsWith('/validate')) return validateResponse();
    const outcome = outcomes[poll++];
    if (outcome === 'success') return jsonResponse(validTokens);
    return jsonResponse({ message: outcome }, 400);
  }) as typeof fetch;
}

test('device login polls pending and slow_down before success', async () => {
  const waits: number[] = [];
  let savedLogin = '';
  await deviceLogin('client', 'STREAMER', async (tokens) => {
    savedLogin = tokens.login ?? '';
  }, {
    fetcher: deviceFetcher(['authorization_pending', 'slow_down', 'success']),
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(waits, [1000, 1000, 6000]);
  assert.equal(savedLogin, 'streamer');
});

test('device login reports denial and expiry', async () => {
  for (const [message, expected] of [
    ['access_denied', /denied/],
    ['expired_token', /expired/],
  ] as const) {
    await assert.rejects(deviceLogin('client', 'streamer', async () => undefined, {
      fetcher: deviceFetcher([message]),
      sleep: async () => undefined,
    }), expected);
  }
});

test('device token file is written with mode 600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-auth-'));
  const tokenPath = join(directory, 'tokens.json');
  try {
    const { atomicJson } = await import('../src/util/files.ts');
    await atomicJson(tokenPath, validTokens);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(tokenPath, 'utf8')).access_token, 'access');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validation rejects a different login and missing scopes', async () => {
  await assert.rejects(
    validateToken('access', 'client', 'other', async () => validateResponse()),
    /does not match/,
  );
  await assert.rejects(validateToken('access', 'client', 'streamer', async () => jsonResponse({
    ...identity,
    scopes: [],
  })), /Missing required/);
});

test('refresh token rotation persists before returning the access token', async () => {
  let persisted = false;
  const rotated = await refreshTokens(validTokens, 'client', async (tokens) => {
    assert.equal(tokens.refresh_token, 'new-refresh');
    persisted = true;
  }, async () => jsonResponse({
    ...validTokens,
    access_token: 'new-access',
    refresh_token: 'new-refresh',
  }));
  assert.equal(persisted, true);
  assert.equal(rotated.access_token, 'new-access');
});

test('chat settings bounds accept edges and reject outside values', () => {
  for (const seconds of [3, 120]) validatePatch({ slow_mode_wait_time: seconds });
  for (const seconds of [2, 121, 3.5]) {
    assert.throws(() => validatePatch({ slow_mode_wait_time: seconds }));
  }
  for (const minutes of [0, 129600]) validatePatch({ follower_mode_duration: minutes });
  for (const minutes of [-1, 129601, 2.2]) {
    assert.throws(() => validatePatch({ follower_mode_duration: minutes }));
  }
  for (const field of [
    'slow_mode', 'follower_mode', 'emote_mode', 'subscriber_mode', 'unique_chat_mode',
  ] as const) {
    validatePatch({ [field]: true });
    assert.throws(() => validatePatch({ [field]: 'true' }));
  }
});

test('Helix waits until rate reset, retries once, and exposes remaining', async () => {
  let requests = 0;
  let waited = 0;
  const helix = new Helix('client', validTokens, async () => undefined, {
    fetcher: async () => {
      requests++;
      return requests === 1
        ? jsonResponse({}, 429, {
          'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 10),
          'Ratelimit-Remaining': '0',
        })
        : jsonResponse({ ok: true }, 200, { 'Ratelimit-Remaining': '17' });
    },
    sleep: async (milliseconds) => { waited = milliseconds; },
  });
  assert.deepEqual(await helix.request('test'), { ok: true });
  assert.equal(requests, 2);
  assert.ok(waited > 0);
  assert.equal(helix.remaining, '17');
});

test('Helix refreshes once after 401 and retries with the new access token', async () => {
  let requests = 0;
  let persisted = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) {
      return jsonResponse({
        ...validTokens,
        access_token: 'rotated',
        refresh_token: 'rotated-refresh',
      });
    }
    requests++;
    const headers = new Headers(init?.headers);
    if (headers.get('Authorization') === 'Bearer access') return jsonResponse({}, 401);
    return jsonResponse({ ok: true }, 200, { 'Ratelimit-Remaining': '9' });
  };
  const helix = new Helix('client', validTokens, async () => { persisted = true; }, { fetcher });
  assert.deepEqual(await helix.request('test'), { ok: true });
  assert.equal(requests, 2);
  assert.equal(persisted, true);
  assert.equal(helix.remaining, '9');
});

test('Helix does not repeat a failed retry', async () => {
  let requests = 0;
  const helix = new Helix('client', validTokens, async () => undefined, {
    fetcher: async () => {
      requests++;
      return jsonResponse({}, requests === 1 ? 429 : 500, {
        'Ratelimit-Reset': String(Math.floor(Date.now() / 1000)),
      });
    },
    sleep: async () => undefined,
  });
  await assert.rejects(helix.request('test'), /500/);
  assert.equal(requests, 2);
});

test('EventSub welcome subscribes to four types within the deadline', async () => {
  FakeSocket.reset();
  const calls: string[] = [];
  const client = new EventSub(
    { request: async (path: string) => { calls.push(path); } } as Helix,
    '42',
    () => undefined,
    FakeSocket,
    () => undefined,
  );
  const connected = client.connect();
  FakeSocket.instances[0].sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'session', keepalive_timeout_seconds: 20 } },
  });
  await connected;
  assert.equal(calls.length, 4);
  client.close();
});

test('EventSub closes the socket and does not retry subscriptions after deadline', async () => {
  FakeSocket.reset();
  let calls = 0;
  const logs: unknown[] = [];
  const client = new EventSub(
    {
      request: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    } as Helix,
    '42',
    () => undefined,
    FakeSocket,
    (entry) => logs.push(entry),
    { welcomeDeadlineMs: 8 },
  );
  const connected = client.connect();
  FakeSocket.instances[0].sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'session' } },
  });
  await assert.rejects(connected, /deadline/);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(calls, 1);
  assert.equal(FakeSocket.instances[0].closed, true);
  assert.ok(logs.length > 0);
  client.close();
});

test('EventSub keepalive timeout opens a fresh connection and subscribes again', async () => {
  FakeSocket.reset();
  let subscriptions = 0;
  const client = new EventSub(
    { request: async () => { subscriptions++; } } as Helix,
    '42',
    () => undefined,
    FakeSocket,
    () => undefined,
    { welcomeDeadlineMs: 50, keepaliveMarginMs: 2 },
  );
  const connected = client.connect();
  FakeSocket.instances[0].sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'one', keepalive_timeout_seconds: 0 } },
  });
  await connected;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(FakeSocket.instances.length, 2);
  FakeSocket.instances[1].sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'two', keepalive_timeout_seconds: 10 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscriptions, 8);
  client.close();
});

test('EventSub notification resets keepalive timer and deduplicates message ids', async () => {
  FakeSocket.reset();
  const events: string[] = [];
  const client = new EventSub(
    { request: async () => undefined } as Helix,
    '42',
    (event) => events.push(event.message_id),
    FakeSocket,
    () => undefined,
    { welcomeDeadlineMs: 50, keepaliveMarginMs: 2 },
  );
  const connected = client.connect();
  const socket = FakeSocket.instances[0];
  socket.sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'one', keepalive_timeout_seconds: 0.01 } },
  });
  await connected;
  socket.sendMessage({
    metadata: { message_type: 'notification', message_id: 'same' },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '42',
        chatter_user_id: '9',
        message_id: 'x',
        message: { text: 'hi' },
      },
    },
  });
  socket.sendMessage({
    metadata: { message_type: 'notification', message_id: 'same' },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '42',
        chatter_user_id: '9',
        message_id: 'x',
        message: { text: 'hi' },
      },
    },
  });
  assert.deepEqual(events, ['same']);
  client.close();
});

test('EventSub reconnect hands over after welcome without re-subscribing', async () => {
  FakeSocket.reset();
  let subscriptions = 0;
  const logs: unknown[] = [];
  const client = new EventSub(
    { request: async () => { subscriptions++; } } as Helix,
    '42',
    () => undefined,
    FakeSocket,
    (entry) => logs.push(entry),
    { welcomeDeadlineMs: 20, keepaliveMarginMs: 100 },
  );
  const connected = client.connect();
  const oldSocket = FakeSocket.instances[0];
  oldSocket.sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'old', keepalive_timeout_seconds: 20 } },
  });
  await connected;
  oldSocket.sendMessage({
    metadata: { message_type: 'session_reconnect' },
    payload: { session: { reconnect_url: 'wss://reconnect' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const nextSocket = FakeSocket.instances[1];
  assert.equal(oldSocket.closed, false);
  nextSocket.sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'new', keepalive_timeout_seconds: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldSocket.closed, true);
  assert.equal(subscriptions, 4);
  assert.equal(client.active, nextSocket);
  assert.ok(logs.some((entry) => JSON.stringify(entry).includes('close')));
  client.close();
});

test('EventSub keeps old connection when reconnect socket fails to welcome', async () => {
  FakeSocket.reset();
  const logs: unknown[] = [];
  const client = new EventSub(
    { request: async () => undefined } as Helix,
    '42',
    () => undefined,
    FakeSocket,
    (entry) => logs.push(entry),
    { welcomeDeadlineMs: 8, keepaliveMarginMs: 100 },
  );
  const connected = client.connect();
  const oldSocket = FakeSocket.instances[0];
  oldSocket.sendMessage({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id: 'old', keepalive_timeout_seconds: 20 } },
  });
  await connected;
  oldSocket.sendMessage({
    metadata: { message_type: 'session_reconnect' },
    payload: { session: { reconnect_url: 'wss://reconnect' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(oldSocket.closed, false);
  assert.ok(logs.some((entry) => JSON.stringify(entry).includes('handover_failed')));
  client.close();
});

test('baseline is saved before a change and later restore recovers a crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-baseline-'));
  const baselinePath = join(directory, 'baseline.json');
  let current = { ...baselineSettings };
  const api = {
    get: async () => ({ ...current }),
    update: async (patch: Partial<typeof current>) => { current = { ...current, ...patch }; },
  };
  try {
    const beforeChange = await api.get();
    await saveBaseline(baselinePath, beforeChange);
    await api.update({ slow_mode: true, slow_mode_wait_time: 10 });
    assert.equal(current.slow_mode, true);
    await restoreBaseline(api, baselinePath);
    assert.equal(current.slow_mode, baselineSettings.slow_mode);
    assert.equal(current.follower_mode, baselineSettings.follower_mode);
    assert.equal(current.emote_mode, baselineSettings.emote_mode);
    assert.deepEqual(JSON.parse(await readFile(baselinePath, 'utf8')), baselineSettings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('probe restores the baseline when the change call fails part-way', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-probe-'));
  const baselinePath = join(directory, 'baseline.json');
  let current = { ...baselineSettings };
  const api = {
    get: async () => ({ ...current }),
    update: async (patch: Partial<typeof current>) => {
      current = { ...current, ...patch };
      if (patch.slow_mode) throw new Error('simulated interruption');
    },
  };
  try {
    await assert.rejects(probeWithRestore(
      api,
      baselinePath,
      () => api.update({ slow_mode: true, slow_mode_wait_time: 10 }),
      async () => undefined,
    ), /simulated interruption/);
    assert.equal(current.slow_mode, baselineSettings.slow_mode);
    assert.equal(current.follower_mode, baselineSettings.follower_mode);
    assert.equal(current.emote_mode, baselineSettings.emote_mode);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
