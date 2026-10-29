import type { ChatSettingsPatch } from '../../src/actuator/settings.ts';
import { Helix } from '../../src/util/helix.ts';
import { baselineSettings, validTokens } from './fixtures.ts';
import { jsonResponse } from './fakes.ts';

export type PatchFailure = 'timeout' | 'abort' | 'server';

export class PatchFailureSurface {
  settings = { ...baselineSettings };
  methods: string[] = [];
  patchCount = 0;
  getCount = 0;
  private failure: PatchFailure;
  private applied: boolean;

  constructor(failure: PatchFailure, applied: boolean) {
    this.failure = failure;
    this.applied = applied;
  }

  createHelix(): Helix {
    return new Helix('test-client', validTokens, async () => undefined, {
      fetcher: (input, init) => this.fetchRequest(input, init),
    });
  }

  private async fetchRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.methods.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/chat/settings')) {
      if (method === 'PATCH') return this.patch(init);
      this.getCount += 1;
      return jsonResponse({ data: [{ ...this.settings }] });
    }
    return jsonResponse({ data: [] });
  }

  private patch(init?: RequestInit): Response {
    this.patchCount += 1;
    const patch = JSON.parse(String(init?.body)) as ChatSettingsPatch;
    if (this.patchCount === 1) {
      if (this.applied) this.settings = { ...this.settings, ...patch };
      if (this.failure === 'server') return jsonResponse({ message: 'Unavailable' }, 503);
      const name = this.failure === 'timeout' ? 'TimeoutError' : 'AbortError';
      throw new DOMException('Simulated request did not complete', name);
    }
    this.settings = { ...this.settings, ...patch };
    return jsonResponse({ data: [{ ...this.settings }] });
  }
}
