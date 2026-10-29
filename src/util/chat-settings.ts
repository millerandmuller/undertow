import type { ChatSettings, ChatSettingsPatch } from '../actuator/settings.ts';
import type { ChatSettingsNotification } from '../eventsub/client.ts';

export type NullableChatSettings = Omit<ChatSettings,
  'slow_mode_wait_time' | 'follower_mode_duration'> & {
  slow_mode_wait_time: number | null;
  follower_mode_duration: number | null;
};

export function normalizeChatSettings(settings: NullableChatSettings): ChatSettings {
  return {
    ...settings,
    slow_mode_wait_time: settings.slow_mode_wait_time ?? 0,
    follower_mode_duration: settings.follower_mode_duration ?? 0,
  };
}

export function settingsEventPatch(event: ChatSettingsNotification): ChatSettingsPatch {
  const patch: ChatSettingsPatch = {};
  const booleans = [
    'slow_mode', 'follower_mode', 'emote_mode', 'subscriber_mode', 'unique_chat_mode',
  ] as const;
  for (const key of booleans) {
    if (event[key] !== undefined) patch[key] = event[key];
  }
  const wait = event.slow_mode_wait_time_seconds !== undefined
    ? event.slow_mode_wait_time_seconds : event.slow_mode_wait_time;
  const duration = event.follower_mode_duration_minutes !== undefined
    ? event.follower_mode_duration_minutes : event.follower_mode_duration;
  if (wait !== undefined) patch.slow_mode_wait_time = wait ?? 0;
  if (duration !== undefined) patch.follower_mode_duration = duration ?? 0;
  return patch;
}

export function matchesChatSettings(patch: ChatSettingsPatch, settings: ChatSettings): boolean {
  const keys = Object.keys(patch) as (keyof ChatSettings)[];
  return keys.length > 0 && keys.every((key) => {
    if (key === 'slow_mode_wait_time' && patch.slow_mode === false && !settings.slow_mode) {
      return true;
    }
    if (key === 'follower_mode_duration' && patch.follower_mode === false &&
      !settings.follower_mode) return true;
    return patch[key] === settings[key];
  });
}
