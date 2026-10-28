import type {
  EventSubSocket,
  EventSubSocketConstructor,
  UndertowEvent,
} from '../eventsub/client.ts';

type Incoming = { data: string };
type Closing = { code: number };

export class SimulatedSocket implements EventSubSocket {
  static instances: SimulatedSocket[] = [];
  readyState = 1;
  onmessage: ((event: Incoming) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: Closing) => void) | null = null;
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    SimulatedSocket.instances.push(this);
    queueMicrotask(() => this.welcome());
  }

  welcome(): void {
    this.send({
      metadata: { message_type: 'session_welcome' },
      payload: {
        session: {
          id: `sim-session-${SimulatedSocket.instances.indexOf(this)}`,
          keepalive_timeout_seconds: 300,
        },
      },
    });
  }

  emit(event: UndertowEvent): void {
    this.send({
      metadata: { message_type: 'notification', message_id: event.message_id },
      payload: { subscription: { type: event.type }, event: event.event },
    });
  }

  reconnect(url: string): void {
    this.send({
      metadata: { message_type: 'session_reconnect' },
      payload: { session: { reconnect_url: url } },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  private send(value: unknown): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) });
  }
}

export const SimulatedSocketConstructor = SimulatedSocket as
  EventSubSocketConstructor;

export function resetSimulatedSockets(): void {
  for (const socket of SimulatedSocket.instances) socket.close();
  SimulatedSocket.instances = [];
}

export function emitSimulatedEvent(event: UndertowEvent): void {
  const socket = SimulatedSocket.instances.findLast((item) => !item.closed);
  socket?.emit(event);
}

export function forceSimulatedReconnect(): void {
  const socket = SimulatedSocket.instances.findLast((item) => !item.closed);
  socket?.reconnect('wss://simulated-eventsub-reconnect.invalid/ws');
}
