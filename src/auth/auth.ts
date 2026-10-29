import { REQUEST_TIMEOUT_MS, requestSignal } from '../util/http.ts';

export const REQUIRED_SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'moderator:manage:chat_settings',
];

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

type DeviceResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type ValidateIdentity = {
  user_id: string;
  login: string;
  scopes: string[] | null;
};

type ValidatePayload = Omit<ValidateIdentity, 'scopes'> & {
  scopes: string[] | null;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
};

export type Tokens = TokenResponse & Partial<ValidateIdentity>;

export class TokenValidationError extends Error {
  status: number;

  constructor(status: number) {
    super(`Token validation failed (${status})`);
    this.name = 'TokenValidationError';
    this.status = status;
  }
}

export type DeviceLoginOptions = {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  onCode?: (code: string, uri: string) => void;
  scopes?: string[];
  requestTimeoutMs?: number;
};

function form(body: Record<string, string>, timeoutMs: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: requestSignal(timeoutMs),
  };
}

export async function validateToken(
  token: string,
  _clientId: string,
  expectedLogin: string,
  fetcher: typeof fetch = fetch,
  requiredScopes: string[] = REQUIRED_SCOPES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ValidateIdentity> {
  const response = await fetcher(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${token}` },
    signal: requestSignal(requestTimeoutMs),
  });
  if (!response.ok) throw new TokenValidationError(response.status);

  const received = await response.json() as ValidatePayload;
  const identity: ValidateIdentity = { ...received, scopes: received.scopes ?? [] };
  if (identity.login.toLowerCase() !== expectedLogin.toLowerCase()) {
    throw new Error(
      `Authenticated login ${identity.login} does not match TWITCH_CHANNEL_LOGIN ${expectedLogin}`,
    );
  }
  const missing = requiredScopes.filter((scope) => !identity.scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Missing required Twitch scopes: ${missing.join(', ')}`);
  }
  return identity;
}

async function requestDeviceCode(
  clientId: string,
  fetcher: typeof fetch,
  scopes: string[],
  timeoutMs: number,
): Promise<DeviceResponse> {
  const response = await fetcher(DEVICE_URL, form({
    client_id: clientId,
    scopes: scopes.join(' '),
  }, timeoutMs));
  if (!response.ok) {
    throw new Error(`Device authorization failed (${response.status})`);
  }
  return await response.json() as DeviceResponse;
}

async function pollToken(
  clientId: string,
  deviceCode: string,
  fetcher: typeof fetch,
  scopes: string[],
  timeoutMs: number,
): Promise<Response> {
  return fetcher(TOKEN_URL, form({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
    scopes: scopes.join(' '),
  }, timeoutMs));
}

export async function deviceLogin(
  clientId: string,
  expectedLogin: string,
  save: (tokens: Tokens) => Promise<void>,
  options: DeviceLoginOptions = {},
): Promise<Tokens> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const scopes = options.scopes ?? REQUIRED_SCOPES;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const device = await requestDeviceCode(clientId, fetcher, scopes, timeoutMs);
  options.onCode?.(device.user_code, device.verification_uri);
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const response = await pollToken(clientId, device.device_code, fetcher, scopes, timeoutMs);
    const result = await response.json() as TokenResponse | { message?: string };
    if (response.ok) {
      const token = result as TokenResponse;
      const identity = await validateToken(
        token.access_token,
        clientId,
        expectedLogin,
        fetcher,
        scopes,
        timeoutMs,
      );
      const tokens: Tokens = { ...token, ...identity };
      await save(tokens);
      return tokens;
    }
    const message = 'message' in result ? result.message : undefined;
    if (message === 'authorization_pending') continue;
    if (message === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (message === 'expired_token') throw new Error('Device code expired; run login again');
    if (message === 'access_denied') throw new Error('Device login was denied');
    throw new Error(`Device token request failed: ${message ?? response.status}`);
  }
  throw new Error('Device code expired; run login again');
}

export async function validateStoredToken(
  tokens: Tokens,
  clientId: string,
  expectedLogin: string,
  persist: (tokens: Tokens) => Promise<void>,
  fetcher: typeof fetch = fetch,
  clientSecret?: string,
  requiredScopes: string[] = REQUIRED_SCOPES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ tokens: Tokens; identity: ValidateIdentity }> {
  try {
    const identity = await validateToken(
      tokens.access_token,
      clientId,
      expectedLogin,
      fetcher,
      requiredScopes,
      requestTimeoutMs,
    );
    return { tokens, identity };
  } catch (error) {
    if (!(error instanceof TokenValidationError) || error.status !== 401) throw error;
  }

  if (!tokens.refresh_token) {
    throw new Error('Access token expired and no refresh token is available; run npm run login');
  }

  let refreshed: Tokens;
  try {
    refreshed = await refreshTokens(
      tokens, clientId, persist, fetcher, clientSecret, requestTimeoutMs,
    );
  } catch {
    throw new Error('Access token refresh failed; run npm run login');
  }
  try {
    const identity = await validateToken(
      refreshed.access_token,
      clientId,
      expectedLogin,
      fetcher,
      requiredScopes,
      requestTimeoutMs,
    );
    return { tokens: refreshed, identity };
  } catch (error) {
    if (error instanceof TokenValidationError && error.status === 401) {
      throw new Error('Access token is still invalid after refresh; run npm run login');
    }
    throw error;
  }
}

export async function refreshTokens(
  tokens: Tokens,
  clientId: string,
  persist: (tokens: Tokens) => Promise<void>,
  fetcher: typeof fetch = fetch,
  clientSecret?: string,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Tokens> {
  const body: Record<string, string> = {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  };
  if (clientSecret) body.client_secret = clientSecret;
  const response = await fetcher(TOKEN_URL, form(body, requestTimeoutMs));
  if (!response.ok) throw new Error(`Token refresh failed (${response.status})`);
  const rotated = { ...tokens, ...await response.json() as TokenResponse };
  // Twitch invalidates the previous refresh token as soon as it rotates it.
  await persist(rotated);
  return rotated;
}
