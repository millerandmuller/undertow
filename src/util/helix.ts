import { refreshTokens, type Tokens } from '../auth/auth.ts';

export type HelixError = {
  error?: string;
  status?: number;
  message?: string;
};

type HelixOptions = {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  clientSecret?: string;
};

export class Helix {
  remaining: string | null = null;
  reset: string | null = null;
  clientId: string;
  tokens: Tokens;
  persist: (tokens: Tokens) => Promise<void>;
  fetcher: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  clientSecret?: string;

  constructor(
    clientId: string,
    tokens: Tokens,
    persist: (tokens: Tokens) => Promise<void>,
    options: HelixOptions = {},
  ) {
    this.clientId = clientId;
    this.tokens = tokens;
    this.persist = persist;
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.clientSecret = options.clientSecret;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.tokens.access_token}`);
    headers.set('Client-Id', this.clientId);
    if (init.body) headers.set('Content-Type', 'application/json');
    return this.fetcher(`https://api.twitch.tv/helix/${path}`, { ...init, headers });
  }

  private keepRateLimit(response: Response): void {
    this.remaining = response.headers.get('Ratelimit-Remaining');
    this.reset = response.headers.get('Ratelimit-Reset');
  }

  private async waitForReset(): Promise<void> {
    const resetAt = Number(this.reset ?? 0) * 1000;
    await this.sleep(Math.max(0, resetAt - Date.now()));
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response = await this.send(path, init);
    this.keepRateLimit(response);
    if (response.status === 401) {
      this.tokens = await refreshTokens(
        this.tokens,
        this.clientId,
        this.persist,
        this.fetcher,
        this.clientSecret,
      );
      response = await this.send(path, init);
      this.keepRateLimit(response);
    } else if (response.status === 429) {
      await this.waitForReset();
      response = await this.send(path, init);
      this.keepRateLimit(response);
    }
    if (!response.ok) {
      throw new Error(`Helix request failed (${response.status}): ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  }
}
