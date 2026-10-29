import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loginAccount } from '../src/auth/accounts.ts';
import { loadAccounts } from '../src/loadtest/accounts.ts';
import { loadtestBadge, readLoadtestBadge } from '../src/loadtest/state.ts';
import {
  deterministicUnit,
  intervalMs,
  parseLoadtestRate,
  rateAt,
  RollingMessageLimiter,
} from '../src/loadtest/scheduler.ts';
import { runLoadtest, type LoadtestClock } from '../src/loadtest/runner.ts';
import { Helix } from '../src/util/helix.ts';
import { jsonResponse } from './helpers/fakes.ts';
import { validTokens } from './helpers/fixtures.ts';

test('load-test rate cap names Twitch plain-user limit', () => {
  assert.deepEqual(parseLoadtestRate(0.6, 10, 5), {
    rate: 0.6,
    burstSeconds: 10,
    taperSeconds: 5,
  });
  assert.throws(() => parseLoadtestRate(0.61, 10, 5), /20 messages per 30 seconds/);
});

test('load-test dry plan lists account and sends no requests', async () => {
  const directory = await temporaryDirectory();
  try {
    await mkdir(join(directory, 'accounts'));
    await writeFile(join(directory, 'accounts', 'friend.json'), '{}');
    const result = spawnSync(process.execPath, [
      'src/cli.ts', 'loadtest', '--dry', '--rate', '0.5', '--burst', '10',
      '--taper', '3',
    ], {
      encoding: 'utf8',
      env: {
        UNDERTOW_STATE_DIR: directory,
        TWITCH_CLIENT_ID: 'client',
        TWITCH_CHANNEL_LOGIN: 'streamer',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LOAD TEST PLAN/);
    assert.match(result.stdout, /accounts: friend/);
    assert.match(result.stdout, /channel: streamer/);
    assert.doesNotMatch(result.stdout, /modeled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load-test schedule is deterministic and taper rate falls linearly', () => {
  assert.equal(deterministicUnit('account', 4), deterministicUnit('account', 4));
  assert.equal(intervalMs('account', 4, 0.5), intervalMs('account', 4, 0.5));
  const plan = parseLoadtestRate(0.5, 10, 20);
  assert.equal(rateAt(10, plan), 0.5);
  assert.equal(rateAt(20, plan), 0.25);
  assert.equal(rateAt(30, plan), 0);
});

test('rolling account limiter permits at most 18 messages in 30 seconds', () => {
  const limiter = new RollingMessageLimiter();
  for (let index = 0; index < 18; index += 1) {
    assert.equal(limiter.record(index * 1000), true);
  }
  assert.equal(limiter.nextAllowedAt(17_999), 30_000);
  assert.equal(limiter.record(18_000), false);
  assert.equal(limiter.record(30_000), true);
});

test('account login requests write scope only and writes mode 600', async () => {
  const directory = await temporaryDirectory();
  const scopes: string[] = [];
  try {
    const tokens = await loginAccount({
      clientId: 'client',
      broadcasterLogin: 'streamer',
      accountLogin: 'plainfriend',
      stateDirectory: directory,
      device: {
        fetcher: accountLoginFetcher(scopes),
        sleep: async () => undefined,
      },
    });
    assert.equal(tokens.login, 'plainfriend');
    assert.deepEqual(scopes, ['user:write:chat', 'user:write:chat']);
    const file = join(directory, 'accounts', 'plainfriend.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'accounts'))).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('account login rejects wrong identity without writing and refuses broadcaster', async () => {
  const directory = await temporaryDirectory();
  try {
    await assert.rejects(loginAccount({
      clientId: 'client',
      broadcasterLogin: 'streamer',
      accountLogin: 'plainfriend',
      stateDirectory: directory,
      device: {
        fetcher: accountLoginFetcher([], 'someoneelse'),
        sleep: async () => undefined,
      },
    }), /does not match/);
    await assert.rejects(stat(join(directory, 'accounts')));
    await assert.rejects(loginAccount({
      clientId: 'client',
      broadcasterLogin: 'Streamer',
      accountLogin: 'streamer',
      stateDirectory: directory,
    }), /broadcaster/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load account validation skips dead account and loads remaining account', async () => {
  const directory = await temporaryDirectory();
  const accountDirectory = join(directory, 'accounts');
  const skipped: string[] = [];
  try {
    await mkdir(accountDirectory);
    await saveAccount(accountDirectory, 'dead', 'dead-access');
    await saveAccount(accountDirectory, 'friend', 'friend-access');
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/token')) return jsonResponse({}, 400);
      const token = new Headers(init?.headers).get('Authorization');
      if (token === 'OAuth dead-access') return jsonResponse({}, 401);
      return jsonResponse({
        user_id: 'friend-id',
        login: 'friend',
        scopes: ['user:write:chat'],
      });
    };
    const accounts = await loadAccounts({
      directory: accountDirectory,
      clientId: 'client',
      broadcasterLogin: 'streamer',
      fetcher,
      onSkip: (login) => skipped.push(login),
    });
    assert.deepEqual(skipped, ['dead']);
    assert.deepEqual(accounts.map((account) => account.login), ['friend']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load account files refuse the broadcaster', async () => {
  const directory = await temporaryDirectory();
  try {
    await saveAccount(directory, 'streamer', 'token');
    await assert.rejects(loadAccounts({
      directory,
      clientId: 'client',
      broadcasterLogin: 'STREAMER',
    }), /Broadcaster account file refused/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load-test state badge handles active, inactive, stale, and missing files', async () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const active = {
    active: true,
    accounts: 8,
    rate_per_account: 0.5,
    updated_at: new Date(now).toISOString(),
  };
  assert.equal(loadtestBadge(active, now), 'load test, 8 accounts');
  assert.equal(loadtestBadge({ ...active, active: false }, now), null);
  assert.equal(loadtestBadge(active, now + 10_001), null);
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, 'loadtest.state.json');
    await writeFile(path, JSON.stringify(active));
    assert.equal(await readLoadtestBadge(path, now), 'load test, 8 accounts');
    assert.equal(await readLoadtestBadge(join(directory, 'missing.json'), now), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load-test messages use the visible prefix and count drop reasons once', async () => {
  const directory = await temporaryDirectory();
  const bodies: Record<string, unknown>[] = [];
  const requests: number[] = [];
  const output: string[] = [];
  let stateWasActive = false;
  const account = fakeAccount('friend', 'friend-id', async (_input, init) => {
    requests.push(1);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const state = JSON.parse(await readFile(
      join(directory, 'loadtest.state.json'),
      'utf8',
    )) as { active: boolean };
    stateWasActive ||= state.active;
    return jsonResponse({
      data: [{ is_sent: false, drop_reason: { code: 'rate_limited' } }],
    });
  });
  try {
    await runLoadtest({
      accounts: [account],
      broadcasterId: 'streamer-id',
      channelLogin: 'streamer',
      stateDirectory: directory,
      lines: ['hello kindly'],
      rate: parseLoadtestRate(0.5, 2, 0),
      countdownSeconds: 0,
      clock: simulatedClock(),
      output: (line) => output.push(line),
    });
    assert.ok(requests.length > 0);
    assert.equal(requests.length, bodies.length);
    assert.equal(stateWasActive, true);
    assert.ok(bodies.every((body) => String(body.message).startsWith('[load test] ')));
    assert.ok(bodies.every((body) => body.sender_id === 'friend-id'));
    assert.ok(output.some((line) => line.includes('"rate_limited":')));
    assert.ok(output.every((line) => !line.includes('modeled')));
    assert.equal(JSON.parse(await readFile(join(directory, 'loadtest.state.json'), 'utf8'))
      .active, false);
    const log = await readFile(join(directory, 'loadtest.log.jsonl'), 'utf8');
    assert.ok(log.split('\n').filter(Boolean).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load-test summary separates accepted burst and taper rates', async () => {
  const directory = await temporaryDirectory();
  const output: string[] = [];
  try {
    await runLoadtest({
      accounts: [fakeAccount('friend', 'friend-id', async () => jsonResponse({
        data: [{ is_sent: true, drop_reason: null }],
      }))],
      broadcasterId: 'streamer-id',
      channelLogin: 'streamer',
      stateDirectory: directory,
      lines: ['hello'],
      rate: parseLoadtestRate(0.5, 2, 2),
      countdownSeconds: 0,
      clock: simulatedClock(),
      output: (line) => output.push(line),
    });
    assert.ok(output.some((line) => /^burst 0-2s: \d+ accepted,/.test(line)));
    assert.ok(output.some((line) => /^taper 0-2s: \d+ accepted, \d+\.\d{2}\/s$/
      .test(line)));
    assert.ok(output.every((line) => !line.includes('modeled')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load-test abort prints its summary and writes inactive state', async () => {
  const directory = await temporaryDirectory();
  const output: string[] = [];
  const controller = new AbortController();
  const clock: LoadtestClock = {
    now: () => 0,
    sleep: async () => {
      controller.abort();
      return false;
    },
  };
  try {
    await runLoadtest({
      accounts: [fakeAccount('friend', 'friend-id', async () => jsonResponse({
        data: [{ is_sent: true, drop_reason: null }],
      }))],
      broadcasterId: 'streamer-id',
      channelLogin: 'streamer',
      stateDirectory: directory,
      lines: ['hello'],
      rate: parseLoadtestRate(0.5, 20, 5),
      signal: controller.signal,
      countdownSeconds: 0,
      clock,
      output: (line) => output.push(line),
    });
    assert.ok(output.includes('load test summary'));
    const state = JSON.parse(await readFile(
      join(directory, 'loadtest.state.json'),
      'utf8',
    )) as { active: boolean };
    assert.equal(state.active, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function accountLoginFetcher(scopes: string[], login = 'plainfriend'): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body as URLSearchParams | undefined;
    if (body?.has('scopes')) scopes.push(body.get('scopes') ?? '');
    if (url.endsWith('/device')) {
      return jsonResponse({
        device_code: 'device-code',
        user_code: 'user-code',
        verification_uri: 'https://example.test',
        expires_in: 10,
        interval: 1,
      });
    }
    if (url.endsWith('/token')) return jsonResponse(validTokens);
    return jsonResponse({
      user_id: 'plain-id',
      login,
      scopes: ['user:write:chat'],
    });
  };
}

async function saveAccount(directory: string, login: string, accessToken: string) {
  await writeFile(join(directory, `${login}.json`), JSON.stringify({
    ...validTokens,
    access_token: accessToken,
    refresh_token: `${login}-refresh`,
    login,
  }));
}

function fakeAccount(
  login: string,
  userId: string,
  fetcher: typeof fetch,
) {
  return {
    login,
    userId,
    helix: new Helix('client', validTokens, async () => undefined, { fetcher }),
  };
}

function simulatedClock(): LoadtestClock {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
      return true;
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'undertow-loadtest-'));
}
