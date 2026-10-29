import { matchesChatSettings, settingsEventPatch } from '../util/chat-settings.ts';
import type { ChatSettings, ChatSettingsPatch } from '../actuator/settings.ts';
import type { ChatSettingsNotification, UndertowEvent } from '../eventsub/client.ts';
import { emitSimulatedEvent } from './socket.ts';
import { Helix } from '../util/helix.ts';

export type SimulatedReply = { message: string; parent_id: string | null };

export class SimulatedChannel {
  settings: ChatSettings;
  replies: SimulatedReply[] = [];
  patches: ChatSettingsPatch[] = [];
  private settingRevision = 0;
  private now: () => number;
  private changes: { atMs: number; settings: ChatSettings }[] = [];

  constructor(baseline: ChatSettings, now: () => number = () => 0) {
    this.settings = { ...baseline };
    this.now = now;
  }

  applyRecordedSettings(event: ChatSettingsNotification): void {
    this.settings = { ...this.settings, ...settingsEventPatch(event) };
  }

  hasProducedSettings(event: ChatSettingsNotification): boolean {
    const patch = settingsEventPatch(event);
    return this.changes.some((change) => matchesChatSettings(patch, change.settings));
  }

  matchesRecordedChange(event: ChatSettingsNotification, atMs: number): boolean {
    const patch = settingsEventPatch(event);
    return this.changes.some((change) => Math.abs(change.atMs - atMs) <= 3000 &&
      matchesChatSettings(patch, change.settings));
  }

  createHelix(): Helix {
    const simulatedFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/chat/settings') && (init.method ?? 'GET') === 'GET') {
        return jsonResponse({ data: [{ ...this.settings }] });
      }
      if (url.pathname.endsWith('/chat/settings') && init.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as ChatSettingsPatch;
        this.patches.push({ ...patch });
        this.settings = { ...this.settings, ...patch };
        this.changes.push({ atMs: this.now(), settings: { ...this.settings } });
        const event: UndertowEvent = {
          type: 'channel.chat_settings.update',
          message_id: `sim-settings-${this.settingRevision++}`,
          event: { broadcaster_user_id: url.searchParams.get('broadcaster_id') ?? '', ...patch },
        };
        emitSimulatedEvent(event);
        return jsonResponse({ data: [{ ...this.settings }] });
      }
      if (url.pathname.endsWith('/chat/messages')) {
        const body = JSON.parse(String(init.body)) as {
          message: string;
          reply_parent_message_id?: string;
        };
        this.replies.push({
          message: body.message,
          parent_id: body.reply_parent_message_id ?? null,
        });
        return jsonResponse({ data: [{ is_sent: true, drop_reason: null }] });
      }
      if (url.pathname.endsWith('/eventsub/subscriptions')) return jsonResponse({ data: [] });
      throw new Error(`Unsupported simulated Helix request: ${url.pathname}`);
    };
    return new Helix(
      'simulated-client',
      {
        access_token: 'simulated-access-token',
        refresh_token: 'simulated-refresh-token',
        expires_in: 0,
        scope: [],
        token_type: 'bearer',
      },
      async () => undefined,
      { fetcher: simulatedFetch },
    );
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'ratelimit-remaining': '1000',
      'ratelimit-limit': '1000',
      'ratelimit-reset': '0',
    },
  });
}
