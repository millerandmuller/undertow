import type { Tokens } from '../../src/auth/auth.ts';
import type { ChatSettings } from '../../src/actuator/settings.ts';

export const validTokens: Tokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  scope: ['user:read:chat', 'user:write:chat', 'moderator:manage:chat_settings'],
  token_type: 'bearer',
};

export const baselineSettings: ChatSettings = {
  slow_mode: false,
  slow_mode_wait_time: 0,
  follower_mode: false,
  follower_mode_duration: 0,
  emote_mode: false,
  subscriber_mode: false,
  unique_chat_mode: false,
};
