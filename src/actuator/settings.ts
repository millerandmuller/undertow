import { basename } from 'node:path';
import { atomicJson, readJson } from '../util/files.ts';
import { access, unlink } from 'node:fs/promises';
import type { Helix } from '../util/helix.ts';

export type ChatSettings = {
  slow_mode: boolean;
  slow_mode_wait_time: number;
  follower_mode: boolean;
  follower_mode_duration: number;
  emote_mode: boolean;
  subscriber_mode: boolean;
  unique_chat_mode: boolean;
};

export type ChatSettingsPatch = Partial<ChatSettings>;
export type ChatSettingsResponse = { data: ChatSettings[] };
export type ChatSettingsApi = {
  get(): Promise<ChatSettings>;
  update(patch: ChatSettingsPatch): Promise<unknown>;
};

const BOOLEAN_FIELDS: (keyof ChatSettings)[] = [
  'slow_mode',
  'follower_mode',
  'emote_mode',
  'subscriber_mode',
  'unique_chat_mode',
];

export function validatePatch(patch: ChatSettingsPatch): void {
  const slowWait = patch.slow_mode_wait_time;
  if (slowWait !== undefined && (!Number.isInteger(slowWait) || slowWait < 3 || slowWait > 120)) {
    throw new Error('slow_mode_wait_time must be an integer from 3 to 120');
  }
  const followerDuration = patch.follower_mode_duration;
  if (followerDuration !== undefined && (
    !Number.isInteger(followerDuration) || followerDuration < 0 || followerDuration > 129600
  )) {
    throw new Error('follower_mode_duration must be an integer from 0 to 129600');
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = patch[field];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${field} must be boolean`);
    }
  }
}

function settingsPath(broadcasterId: string): string {
  const query = new URLSearchParams({
    broadcaster_id: broadcasterId,
    moderator_id: broadcasterId,
  });
  return `chat/settings?${query}`;
}

export function chatSettings(helix: Helix, broadcasterId: string): ChatSettingsApi {
  const path = settingsPath(broadcasterId);
  return {
    async get() {
      const response = await helix.request(path) as ChatSettingsResponse;
      return response.data[0];
    },
    async update(patch) {
      validatePatch(patch);
      return helix.request(path, { method: 'PATCH', body: JSON.stringify(patch) });
    },
  };
}

export async function saveBaseline(path: string, settings: ChatSettings): Promise<void> {
  await atomicJson(path, settings);
}

function baselinePatch(baseline: ChatSettings): ChatSettingsPatch {
  const patch: ChatSettingsPatch = {
    slow_mode: baseline.slow_mode,
    follower_mode: baseline.follower_mode,
    emote_mode: baseline.emote_mode,
  };
  if (baseline.slow_mode) patch.slow_mode_wait_time = baseline.slow_mode_wait_time;
  if (baseline.follower_mode) {
    patch.follower_mode_duration = baseline.follower_mode_duration;
  }
  return patch;
}

export async function restoreBaseline(
  api: ChatSettingsApi,
  path: string,
): Promise<ChatSettings> {
  let baseline: ChatSettings;
  try {
    baseline = parseBaseline(await readJson<unknown>(path));
  } catch {
    throw new Error(`${basename(path)} is unreadable: fix or delete it`);
  }
  const patch = baselinePatch(baseline);
  await api.update(patch);
  const actual = await api.get();
  for (const key of Object.keys(patch) as (keyof ChatSettings)[]) {
    if (actual[key] !== patch[key]) {
      throw new Error(`Restore verification failed for ${key}`);
    }
  }
  await unlink(path);
  return actual;
}

export async function probeWithRestore(
  api: ChatSettingsApi,
  path: string,
  change: () => Promise<void>,
  onChanged: () => Promise<void>,
): Promise<ChatSettings> {
  try {
    await access(path);
    throw new Error('Baseline already exists; restore it before probing');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Baseline already exists')) {
      throw error;
    }
  }
  const baseline = await api.get();
  await saveBaseline(path, baseline);
  try {
    await change();
    await onChanged();
  } catch (error) {
    await restoreBaseline(api, path);
    throw error;
  }
  return restoreBaseline(api, path);
}

function parseBaseline(value: unknown): ChatSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid baseline');
  }
  const raw = value as Record<string, unknown>;
  for (const key of BOOLEAN_FIELDS) {
    if (typeof raw[key] !== 'boolean') throw new Error('Invalid baseline');
  }
  const wait = raw.slow_mode_wait_time;
  const duration = raw.follower_mode_duration;
  if (typeof wait !== 'number' || !Number.isInteger(wait) ||
    (wait !== 0 && (wait < 3 || wait > 120))) throw new Error('Invalid baseline');
  if (typeof duration !== 'number' || !Number.isInteger(duration) ||
    duration < 0 || duration > 129600) throw new Error('Invalid baseline');
  return raw as ChatSettings;
}
