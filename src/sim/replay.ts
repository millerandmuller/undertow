import { readFile, writeFile } from 'node:fs/promises';
import type { ChatSettings } from '../actuator/settings.ts';
import type { EventSubEvent, UndertowEvent } from '../eventsub/client.ts';

export type ReplayType =
  | 'channel.chat.message'
  | 'channel.chat.notification'
  | 'channel.chat_settings.update'
  | 'channel.raid';

export type ReplayHeader = {
  kind: 'header';
  version: 1;
  label: string;
  synthetic: boolean;
  broadcaster_id: string;
  baseline: ChatSettings;
};

export type ReplayEvent = {
  kind: 'event';
  at_ms: number;
  type: ReplayType;
  event: EventSubEvent;
};

export type ReplayFile = { header: ReplayHeader; events: ReplayEvent[] };

const TYPES: ReplayType[] = [
  'channel.chat.message',
  'channel.chat.notification',
  'channel.chat_settings.update',
  'channel.raid',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function validateBaseline(value: unknown): asserts value is ChatSettings {
  if (!isObject(value)) throw new Error('header.baseline must be an object');
  const bools = [
    'slow_mode', 'follower_mode', 'emote_mode', 'subscriber_mode', 'unique_chat_mode',
  ];
  for (const key of bools) {
    if (typeof value[key] !== 'boolean') throw new Error(`baseline.${key} must be boolean`);
  }
  for (const key of ['slow_mode_wait_time', 'follower_mode_duration']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new Error(`baseline.${key} must be a number`);
    }
  }
}

function validateEvent(type: string, event: unknown): asserts event is EventSubEvent {
  if (!TYPES.includes(type as ReplayType)) throw new Error(`unknown replay event type: ${type}`);
  if (!isObject(event)) throw new Error(`event for ${type} must be an object`);
  const fields: Record<ReplayType, string[]> = {
    'channel.chat.message': ['broadcaster_user_id', 'chatter_user_id', 'message_id'],
    'channel.chat.notification': ['broadcaster_user_id', 'chatter_user_id', 'notice_type'],
    'channel.chat_settings.update': ['broadcaster_user_id'],
    'channel.raid': ['from_broadcaster_user_id', 'to_broadcaster_user_id', 'viewers'],
  };
  for (const field of fields[type as ReplayType]) {
    if (field === 'viewers') {
      if (typeof event[field] !== 'number') throw new Error(`event.${field} is required`);
    } else requireString(event[field], `event.${field}`);
  }
  if (type === 'channel.chat.message') {
    if (!isObject(event.message)) {
      throw new Error('event.message is required for channel.chat.message');
    }
    requireString(event.message.text, 'event.message.text');
  }
}

function parseHeader(value: unknown): ReplayHeader {
  if (!isObject(value) || value.kind !== 'header' || value.version !== 1) {
    throw new Error('first replay line must be a version 1 header');
  }
  requireString(value.label, 'header.label');
  requireString(value.broadcaster_id, 'header.broadcaster_id');
  if (typeof value.synthetic !== 'boolean') throw new Error('header.synthetic must be boolean');
  validateBaseline(value.baseline);
  return value as unknown as ReplayHeader;
}

export function parseReplay(text: string): ReplayFile {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('replay file is missing its header');
  let header: ReplayHeader;
  try {
    header = parseHeader(JSON.parse(lines[0]));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('first replay')) throw error;
    throw new Error(`invalid replay header: ${message(error)}`);
  }
  let previous = -1;
  const events = lines.slice(1).map((line, index): ReplayEvent => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON on replay line ${index + 2}`);
    }
    if (!isObject(raw) || raw.kind !== 'event') {
      throw new Error(`replay line ${index + 2} must be an event`);
    }
    if (typeof raw.at_ms !== 'number' || !Number.isFinite(raw.at_ms) || raw.at_ms < 0) {
      throw new Error(`replay line ${index + 2} has invalid at_ms`);
    }
    if (raw.at_ms < previous) throw new Error('replay event offsets must not go backwards');
    previous = raw.at_ms;
    if (typeof raw.type !== 'string') throw new Error(`replay line ${index + 2} is missing type`);
    validateEvent(raw.type, raw.event);
    return raw as unknown as ReplayEvent;
  });
  return { header, events };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function loadReplay(path: string): Promise<ReplayFile> {
  return parseReplay(await readFile(path, 'utf8'));
}

export async function writeReplay(path: string, replay: ReplayFile): Promise<void> {
  const lines = [JSON.stringify(replay.header), ...replay.events.map(JSON.stringify)];
  await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

export function toUndertowEvent(item: ReplayEvent, index: number): UndertowEvent {
  return { type: item.type, message_id: `replay-${index}`, event: item.event };
}
