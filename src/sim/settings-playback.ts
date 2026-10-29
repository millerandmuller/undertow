import type { ChatSettingsNotification } from '../eventsub/client.ts';
import { SimulatedChannel } from './channel.ts';
import { toUndertowEvent, type ReplayEvent } from './replay.ts';
import { emitSimulatedEvent } from './socket.ts';

type PendingSettings = { item: ReplayEvent; index: number };

export class SimulatedSettingsPlayback {
  private channel: SimulatedChannel;
  private pending: PendingSettings[] = [];

  constructor(channel: SimulatedChannel) {
    this.channel = channel;
  }

  accept(item: ReplayEvent, index: number): void {
    const event = item.event as ChatSettingsNotification;
    if (item.own_echo === true) {
      this.applyEchoIfNeeded(event);
    } else if (item.own_echo === false) {
      this.playManual(item, index);
    } else if (this.channel.matchesRecordedChange(event, item.at_ms)) {
      this.applyEchoIfNeeded(event);
    } else {
      // A controller PATCH up to three seconds later can identify a legacy echo.
      this.pending.push({ item, index });
    }
  }

  nextDeadline(): number | null {
    return this.pending.length > 0 ? this.pending[0].item.at_ms + 3000 : null;
  }

  flush(nowMs: number): number {
    const remaining: PendingSettings[] = [];
    let emitted = 0;
    for (const entry of this.pending) {
      const event = entry.item.event as ChatSettingsNotification;
      if (this.channel.matchesRecordedChange(event, entry.item.at_ms)) {
        this.applyEchoIfNeeded(event);
      } else if (nowMs >= entry.item.at_ms + 3000) {
        this.playManual(entry.item, entry.index);
        emitted += 1;
      } else remaining.push(entry);
    }
    this.pending = remaining;
    return emitted;
  }

  private applyEchoIfNeeded(event: ChatSettingsNotification): void {
    if (!this.channel.hasProducedSettings(event)) this.channel.applyRecordedSettings(event);
  }

  private playManual(item: ReplayEvent, index: number): void {
    this.channel.applyRecordedSettings(item.event as ChatSettingsNotification);
    emitSimulatedEvent(toUndertowEvent(item, index));
  }
}
