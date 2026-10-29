import type { Helix } from '../util/helix.ts';

export type ChatMessageNotification = {
  broadcaster_user_id: string;
  chatter_user_id: string;
  message_id: string;
  message: { text: string };
};
export type ChatNotification = {
  broadcaster_user_id: string;
  chatter_user_id: string;
  notice_type: string;
};
export type ChatSettingsNotification = {
  broadcaster_user_id: string;
  slow_mode?: boolean;
  slow_mode_wait_time_seconds?: number | null;
  slow_mode_wait_time?: number | null;
  follower_mode?: boolean;
  follower_mode_duration_minutes?: number | null;
  follower_mode_duration?: number | null;
  emote_mode?: boolean;
  subscriber_mode?: boolean;
  unique_chat_mode?: boolean;
};
export type RaidNotification = {
  from_broadcaster_user_id: string;
  to_broadcaster_user_id: string;
  viewers: number;
};
export type EventSubEvent =
  | ChatMessageNotification
  | ChatNotification
  | ChatSettingsNotification
  | RaidNotification;
export type UndertowEvent = {
  type: string;
  message_id: string;
  event: EventSubEvent;
};

type SubscriptionType =
  | 'channel.chat.message'
  | 'channel.chat.notification'
  | 'channel.chat_settings.update'
  | 'channel.raid';
type Subscription = {
  type: SubscriptionType;
  version: '1';
  condition: Record<string, string>;
  transport: { method: 'websocket'; session_id: string };
};
type EventSubEnvelope = {
  metadata: { message_type: string; message_id?: string };
  payload: {
    session?: {
      id?: string;
      reconnect_url?: string;
      keepalive_timeout_seconds?: number;
    };
    subscription?: { type: string };
    event?: EventSubEvent;
  };
};
type SocketMessage = { data: string };
type SocketClose = { code: number };
export type EventSubSocket = {
  readyState: number;
  onmessage: ((event: SocketMessage) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: SocketClose) => void) | null;
  close(): void;
};
export type EventSubSocketConstructor = new (url: string) => EventSubSocket;
type SocketState = {
  socket: EventSubSocket;
  mode: 'subscribe' | 'handover';
  welcomed: boolean;
  settled: boolean;
  intentionalClose: boolean;
  keepaliveTimer?: ReturnType<typeof setTimeout>;
  welcomeTimer?: ReturnType<typeof setTimeout>;
  resolve: (socket: EventSubSocket) => void;
  reject: (error: Error) => void;
};

export const SUBSCRIPTIONS = [
  'channel.chat.message',
  'channel.chat.notification',
  'channel.chat_settings.update',
  'channel.raid',
] as const;
const CLOSE_MEANINGS: Record<number, string> = {
  4000: 'Internal server error',
  4001: 'Client sent a message',
  4002: 'WebSocket message rate exceeded',
  4003: 'Connection attempted too quickly',
  4004: 'Connection failed',
  4005: 'Connection unused',
  4006: 'Reconnect grace period expired',
  4007: 'Invalid reconnect',
};
const MAX_SOCKETS = 3;
const WELCOME_DEADLINE_MS = 10_000;
const KEEPALIVE_MARGIN_MS = 2_000;
export type EventSubOptions = {
  welcomeDeadlineMs?: number;
  keepaliveMarginMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onFatal?: (error: Error) => void;
};

export class EventSub {
  readonly seen = new Set<string>();
  readonly sockets: EventSubSocket[] = [];
  active: EventSubSocket | null = null;
  private states = new Map<EventSubSocket, SocketState>();
  private helix: Helix;
  private broadcasterId: string;
  private onEvent: (event: UndertowEvent) => void;
  private Socket: EventSubSocketConstructor;
  private log: (entry: unknown) => void;
  private closing = false;
  private welcomeDeadlineMs: number;
  private keepaliveMarginMs: number;
  private sleep: (milliseconds: number) => Promise<void>;
  private now: () => number;
  private onFatal?: (error: Error) => void;

  constructor(
    helix: Helix,
    broadcasterId: string,
    onEvent: (event: UndertowEvent) => void,
    socketConstructor: EventSubSocketConstructor = WebSocket,
    log: (entry: unknown) => void = console.log,
    options: EventSubOptions = {},
  ) {
    this.helix = helix;
    this.broadcasterId = broadcasterId;
    this.onEvent = onEvent;
    this.Socket = socketConstructor;
    this.log = log;
    this.welcomeDeadlineMs = options.welcomeDeadlineMs ?? WELCOME_DEADLINE_MS;
    this.keepaliveMarginMs = options.keepaliveMarginMs ?? KEEPALIVE_MARGIN_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.onFatal = options.onFatal;
  }

  async connect(url = 'wss://eventsub.wss.twitch.tv/ws'): Promise<void> {
    const socket = await this.openSocket(url, 'subscribe');
    this.active = socket;
  }

  private openSocket(url: string, mode: SocketState['mode']): Promise<EventSubSocket> {
    if (this.sockets.length >= MAX_SOCKETS) {
      return Promise.reject(new Error('EventSub connection limit reached'));
    }
    return new Promise((resolve, reject) => {
      const socket = new this.Socket(url);
      const state: SocketState = {
        socket,
        mode,
        welcomed: false,
        settled: false,
        intentionalClose: false,
        resolve,
        reject,
      };
      this.states.set(socket, state);
      this.sockets.push(socket);
      state.welcomeTimer = setTimeout(() => {
        if (state.welcomed) return;
        this.log({ type: 'welcome_timeout' });
        this.closeSocket(state);
        reject(new Error('EventSub session welcome timed out'));
      }, this.welcomeDeadlineMs);
      socket.onmessage = (message) => void this.handleMessage(state, message);
      socket.onerror = () => this.failSocket(state, new Error('EventSub WebSocket error'));
      socket.onclose = (event) => this.handleClose(state, event);
    });
  }

  private async handleMessage(state: SocketState, message: SocketMessage): Promise<void> {
    try {
      const envelope = JSON.parse(message.data) as EventSubEnvelope;
      const kind = envelope.metadata.message_type;
      if (kind === 'session_welcome') await this.handleWelcome(state, envelope);
      else if (kind === 'session_keepalive') this.resetKeepalive(state);
      else if (kind === 'notification') {
        this.handleNotification(envelope);
        this.resetKeepalive(state);
      } else if (kind === 'session_reconnect') {
        await this.handleReconnect(state, envelope);
      } else if (kind === 'revocation') {
        this.log({ type: 'revocation', subscription: envelope.payload.subscription });
      }
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new Error('Invalid EventSub message');
      this.failSocket(state, failure);
    }
  }

  private async handleWelcome(
    state: SocketState,
    envelope: EventSubEnvelope,
  ): Promise<void> {
    if (state.welcomed) return;
    state.welcomed = true;
    clearTimeout(state.welcomeTimer);
    const session = envelope.payload.session;
    if (!session?.id) throw new Error('EventSub welcome did not include a session id');
    this.resetKeepalive(state, session.keepalive_timeout_seconds ?? 10);
    if (state.mode === 'subscribe') {
      try {
        await this.subscribeBeforeDeadline(session.id, state);
      } catch (error) {
        this.failSocket(state, error instanceof Error ? error : new Error('Subscribe failed'));
        return;
      }
    }
    state.settled = true;
    state.resolve(state.socket);
  }

  private async subscribeBeforeDeadline(sessionId: string, state: SocketState): Promise<void> {
    const deadline = Date.now() + this.welcomeDeadlineMs;
    const subscriptions = this.subscriptionRequests(sessionId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadlineFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.log({ type: 'subscribe_deadline' });
        this.closeSocket(state);
        reject(new Error('EventSub subscription deadline exceeded'));
      }, this.welcomeDeadlineMs);
    });
    const subscribe = this.subscribeAll(subscriptions, sessionId, state, deadline);
    try {
      await Promise.race([subscribe, deadlineFailure]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async subscribeAll(
    subscriptions: Subscription[],
    sessionId: string,
    state: SocketState,
    deadline: number,
  ): Promise<void> {
    for (const subscription of subscriptions) {
      if (Date.now() >= deadline || state.intentionalClose) {
        this.log({ type: 'subscribe_deadline' });
        this.closeSocket(state);
        throw new Error('EventSub subscription deadline exceeded');
      }
      await this.helix.request('eventsub/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription),
      });
    }
    if (Date.now() > deadline) {
      this.log({ type: 'subscribe_deadline' });
      this.closeSocket(state);
      throw new Error('EventSub subscription deadline exceeded');
    }
  }

  private subscriptionRequests(sessionId: string): Subscription[] {
    const chatCondition = {
      broadcaster_user_id: this.broadcasterId,
      user_id: this.broadcasterId,
    };
    return SUBSCRIPTIONS.map((type) => ({
      type,
      version: '1',
      condition: type === 'channel.raid'
        ? { to_broadcaster_user_id: this.broadcasterId }
        : chatCondition,
      transport: { method: 'websocket', session_id: sessionId },
    }));
  }

  private resetKeepalive(state: SocketState, seconds?: number): void {
    clearTimeout(state.keepaliveTimer);
    const timeoutSeconds = seconds ?? 10;
    state.keepaliveTimer = setTimeout(() => {
      if (state.intentionalClose || this.closing) return;
      this.log({ type: 'keepalive_timeout' });
      this.closeSocket(state);
      if (this.active === state.socket) {
        this.active = null;
        void this.reconnectFresh();
      }
    }, timeoutSeconds * 1000 + this.keepaliveMarginMs);
  }

  private async reconnectFresh(): Promise<void> {
    this.log({ type: 'reconnect', mode: 'fresh' });
    const started = this.now();
    const backoffs = [1000, 2000, 4000, 8000];
    let attempt = 0;
    let lastError = new Error('EventSub reconnect failed');
    while (!this.closing && this.now() - started < 300_000) {
      try {
        this.active = await this.openSocket('wss://eventsub.wss.twitch.tv/ws', 'subscribe');
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : lastError;
        this.log({ type: 'reconnect_failed', message: lastError.message });
      }
      const waitMs = backoffs[attempt] ?? 15_000;
      attempt += 1;
      await this.sleep(Math.min(waitMs, Math.max(0, 300_000 - (this.now() - started))));
    }
    if (!this.closing) {
      this.log('EVENTSUB RECONNECT FAILED: run Undertow again');
      this.onFatal?.(lastError);
    }
  }

  private async handleReconnect(
    oldState: SocketState,
    envelope: EventSubEnvelope,
  ): Promise<void> {
    const url = envelope.payload.session?.reconnect_url;
    this.log({ type: 'reconnect', mode: 'handover' });
    if (!url) throw new Error('Reconnect message did not include a URL');
    try {
      // Twitch carries subscriptions over; keep the old socket until welcome confirms handover.
      const replacement = await this.openSocket(url, 'handover');
      this.active = replacement;
      this.closeSocket(oldState);
      this.log({ type: 'reconnect_complete', mode: 'handover' });
    } catch (error) {
      this.log({ type: 'handover_failed', message: (error as Error).message });
    }
  }

  private handleNotification(envelope: EventSubEnvelope): void {
    const messageId = envelope.metadata.message_id;
    const event = envelope.payload.event;
    const type = envelope.payload.subscription?.type;
    if (!messageId || !event || !type || this.seen.has(messageId)) return;
    this.seen.add(messageId);
    const notification: UndertowEvent = { type, message_id: messageId, event };
    this.onEvent(notification);
    this.log(notification);
  }

  private failSocket(state: SocketState, error: Error): void {
    if (!state.settled) {
      state.settled = true;
      state.reject(error);
    }
    this.closeSocket(state);
    if (this.active === state.socket) this.active = null;
  }

  private handleClose(state: SocketState, event: SocketClose): void {
    this.clearTimers(state);
    this.removeSocket(state);
    this.log({
      type: 'close',
      code: event.code,
      meaning: CLOSE_MEANINGS[event.code] ?? 'Unknown close code',
    });
    if (!state.settled && !state.intentionalClose) {
      state.settled = true;
      state.reject(new Error('EventSub socket closed before welcome'));
    }
    if (!state.intentionalClose && !this.closing && this.active === state.socket) {
      this.active = null;
      void this.reconnectFresh();
    }
  }

  private closeSocket(state: SocketState): void {
    state.intentionalClose = true;
    this.clearTimers(state);
    state.socket.close();
    this.removeSocket(state);
  }

  private clearTimers(state: SocketState): void {
    clearTimeout(state.keepaliveTimer);
    clearTimeout(state.welcomeTimer);
  }

  private removeSocket(state: SocketState): void {
    this.states.delete(state.socket);
    const index = this.sockets.indexOf(state.socket);
    if (index >= 0) this.sockets.splice(index, 1);
  }

  close(): void {
    this.closing = true;
    for (const state of this.states.values()) this.closeSocket(state);
    this.active = null;
  }
}
