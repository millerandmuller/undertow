import { REQUEST_TIMEOUT_MS, requestSignal } from '../util/http.ts';
import type { Helix } from '../util/helix.ts';

export type ChatSendRequest = {
  broadcaster_id: string;
  sender_id: string;
  message: string;
  reply_parent_message_id?: string;
};

type ChatSendResponse = {
  data: {
    is_sent: boolean;
    drop_reason: string | null;
    message_id: string | null;
  }[];
};

export type ChatSendResult = {
  is_sent: boolean;
  drop_reason: string | null;
  message_id: string | null;
};

export type ChatSenderOptions = {
  now?: () => number;
  requestTimeoutMs?: number;
  log?: (entry: unknown) => void;
};

export class ChatSender {
  private helix: Helix;
  private broadcasterId: string;
  private now: () => number;
  private log: (entry: unknown) => void;
  private requestTimeoutMs: number;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;

  constructor(
    helix: Helix,
    broadcasterId: string,
    options: ChatSenderOptions = {},
  ) {
    this.helix = helix;
    this.broadcasterId = broadcasterId;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.log = options.log ?? console.log;
  }

  async send(message: string, replyParentMessageId?: string): Promise<ChatSendResult> {
    if (message.trim().length === 0) throw new Error('Chat message must not be empty');
    if (message.length > 500) throw new Error('Chat message must be 500 characters or fewer');
    const nowMs = this.now();
    if (nowMs - this.lastAttemptMs < 3000) {
      this.log({ type: 'chat_rate_limited', reason: 'one reply per 3 seconds' });
      return { is_sent: false, drop_reason: null, message_id: null };
    }
    this.lastAttemptMs = nowMs;
    const body: ChatSendRequest = {
      broadcaster_id: this.broadcasterId,
      sender_id: this.broadcasterId,
      message,
    };
    if (replyParentMessageId) body.reply_parent_message_id = replyParentMessageId;
    const response = await this.helix.request('chat/messages', {
      method: 'POST',
      signal: requestSignal(this.requestTimeoutMs),
      body: JSON.stringify(body),
    }) as ChatSendResponse;
    const result = response.data[0];
    if (!result.is_sent) {
      this.log({ type: 'chat_message_dropped', drop_reason: result.drop_reason });
      return {
        is_sent: false,
        drop_reason: result.drop_reason,
        message_id: result.message_id,
      };
    }
    return {
      is_sent: true,
      drop_reason: null,
      message_id: result.message_id,
    };
  }
}
