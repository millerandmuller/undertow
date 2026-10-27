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

type ValidateResponse = {
  user_id: string;
  login: string;
  scopes: string[];
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
};

export type Tokens = TokenResponse & Partial<ValidateResponse>;

export type DeviceLoginOptions = {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  onCode?: (code: string, uri: string) => void;
};

function form(body: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  };
}

export async function validateToken(
  token: string,
  _clientId: string,
  expectedLogin: string,
  fetcher: typeof fetch = fetch,
): Promise<ValidateResponse> {
  const response = await fetcher(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Token validation failed (${response.status})`);
  }

  const identity = await response.json() as ValidateResponse;
  if (identity.login.toLowerCase() !== expectedLogin.toLowerCase()) {
    throw new Error(
      `Authenticated login ${identity.login} does not match TWITCH_CHANNEL_LOGIN ${expectedLogin}`,
    );
  }
  const missing = REQUIRED_SCOPES.filter((scope) => !identity.scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Missing required Twitch scopes: ${missing.join(', ')}`);
  }
  return identity;
}

async function requestDeviceCode(
  clientId: string,
  fetcher: typeof fetch,
): Promise<DeviceResponse> {
  const response = await fetcher(DEVICE_URL, form({
    client_id: clientId,
    scope: REQUIRED_SCOPES.join(' '),
  }));
  if (!response.ok) {
    throw new Error(`Device authorization failed (${response.status})`);
  }
  return await response.json() as DeviceResponse;
}

async function pollToken(
  clientId: string,
  deviceCode: string,
  fetcher: typeof fetch,
): Promise<Response> {
  return fetcher(TOKEN_URL, form({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
  }));
}

export async function deviceLogin(
  clientId: string,
  expectedLogin: string,
  save: (tokens: Tokens) => Promise<void>,
  options: DeviceLoginOptions = {},
): Promise<Tokens> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const device = await requestDeviceCode(clientId, fetcher);
  options.onCode?.(device.user_code, device.verification_uri);
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const response = await pollToken(clientId, device.device_code, fetcher);
    const result = await response.json() as TokenResponse | { message?: string };
    if (response.ok) {
      const token = result as TokenResponse;
      const identity = await validateToken(token.access_token, clientId, expectedLogin, fetcher);
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

export async function refreshTokens(
  tokens: Tokens,
  clientId: string,
  persist: (tokens: Tokens) => Promise<void>,
  fetcher: typeof fetch = fetch,
): Promise<Tokens> {
  const response = await fetcher(TOKEN_URL, form({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  }));
  if (!response.ok) throw new Error(`Token refresh failed (${response.status})`);
  const rotated = { ...tokens, ...await response.json() as TokenResponse };
  // Twitch invalidates the previous refresh token as soon as it rotates it.
  await persist(rotated);
  return rotated;
}
