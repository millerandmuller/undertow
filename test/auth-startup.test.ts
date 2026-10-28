import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStoredToken } from '../src/auth/auth.ts';
import { jsonResponse } from './helpers/fakes.ts';
import { validTokens } from './helpers/fixtures.ts';

const identity = {
  user_id: '42',
  login: 'streamer',
  scopes: validTokens.scope,
};

test('startup refresh persists rotated tokens before validating them', async () => {
  let validations = 0;
  let persisted = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/validate')) {
      validations++;
      if (validations === 1) return jsonResponse({}, 401);
      assert.equal(persisted, true);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'OAuth fresh-access');
      return jsonResponse(identity);
    }
    return jsonResponse({
      ...validTokens,
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
    });
  };
  const result = await validateStoredToken(
    validTokens,
    'client',
    'streamer',
    async (tokens) => {
      assert.equal(tokens.refresh_token, 'fresh-refresh');
      persisted = true;
    },
    fetcher,
    'client-secret',
  );
  assert.equal(validations, 2);
  assert.equal(result.tokens.access_token, 'fresh-access');
  assert.equal(result.identity.login, 'streamer');
});

test('startup refresh sends client secret when set', async () => {
  let secret: string | null = null;
  let validationCount = 0;
  await validateStoredToken(validTokens, 'client', 'streamer', async () => undefined,
    async (input, init) => {
      const url = String(input);
      if (url.endsWith('/validate')) {
        validationCount++;
        return validationCount === 1 ? jsonResponse({}, 401) : jsonResponse(identity);
      }
      secret = (init?.body as URLSearchParams).get('client_secret');
      return jsonResponse(validTokens);
    }, 'startup-secret');
  assert.equal(secret, 'startup-secret');
});

test('startup refresh omits client secret when unset', async () => {
  let body: URLSearchParams | undefined;
  let validationCount = 0;
  await validateStoredToken(validTokens, 'client', 'streamer', async () => undefined,
    async (input, init) => {
      const url = String(input);
      if (url.endsWith('/validate')) {
        validationCount++;
        return validationCount === 1 ? jsonResponse({}, 401) : jsonResponse(identity);
      }
      body = init?.body as URLSearchParams;
      return jsonResponse(validTokens);
    });
  assert.equal(body?.has('client_secret'), false);
});

test('startup expiry without refresh token directs streamer to login', async () => {
  let requests = 0;
  const noRefresh = { ...validTokens, refresh_token: '' };
  await assert.rejects(validateStoredToken(
    noRefresh,
    'client',
    'streamer',
    async () => undefined,
    async () => {
      requests++;
      return jsonResponse({}, 401);
    },
  ), /run npm run login/);
  assert.equal(requests, 1);
});

test('startup refresh rejection directs streamer to login', async () => {
  const fetcher: typeof fetch = async (input) => {
    return String(input).endsWith('/validate')
      ? jsonResponse({}, 401)
      : jsonResponse({ message: 'invalid_grant' }, 400);
  };
  await assert.rejects(validateStoredToken(
    validTokens,
    'client',
    'streamer',
    async () => undefined,
    fetcher,
  ), /Access token refresh failed; run npm run login/);
});

test('startup does not refresh on non-401 validation failures', async () => {
  let tokenRequests = 0;
  await assert.rejects(validateStoredToken(
    validTokens,
    'client',
    'streamer',
    async () => undefined,
    async (input) => {
      if (String(input).endsWith('/token')) tokenRequests++;
      return jsonResponse({}, 403);
    },
  ), /Token validation failed \(403\)/);
  assert.equal(tokenRequests, 0);
});
