import { readFile } from 'node:fs/promises';
import { validatePatch, type ChatSettingsPatch } from './actuator/settings.ts';

export type LadderStep =
  | { kind: 'slow'; label: string; patch: ChatSettingsPatch }
  | { kind: 'followers'; label: string; patch: ChatSettingsPatch }
  | { kind: 'emote'; label: string; patch: ChatSettingsPatch };

export type ProfileConfig = {
  setpoint_msgs_per_s: number;
  window_s: number;
  dwell_s: number;
  release_hold_s: number;
  release_ratio: number;
  sustain_ratio: number;
  warning_boost: number;
  warning_hold_s: number;
  override_hold_s: number;
  ladder: LadderStep[];
};

export type UndertowConfig = {
  real: ProfileConfig;
  loadtest: ProfileConfig;
};

const DEFAULT_CONFIG_PATH = new URL('../undertow.config.json', import.meta.url);
const LADDER_KINDS = ['slow', 'slow', 'slow', 'followers', 'emote'] as const;

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function parseLadder(value: unknown): LadderStep[] {
  if (!Array.isArray(value) || value.length !== LADDER_KINDS.length) {
    throw new Error('ladder must contain exactly the five supported steps');
  }
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`ladder step ${index + 1} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const kind = LADDER_KINDS[index];
    if (item.kind !== kind) throw new Error(`ladder step ${index + 1} must be ${kind}`);
    if (kind === 'slow') {
      const wait = item.slow_mode_wait_time;
      if (typeof wait !== 'number') {
        throw new Error(`ladder slow step ${index + 1} needs slow_mode_wait_time`);
      }
      const patch: ChatSettingsPatch = {
        slow_mode: true,
        slow_mode_wait_time: wait,
      };
      validatePatch(patch);
      return { kind, label: `Slow mode ${wait} s`, patch };
    }
    if (kind === 'followers') {
      const duration = item.follower_mode_duration;
      if (typeof duration !== 'number') {
        throw new Error(`ladder step ${index + 1} needs follower_mode_duration`);
      }
      const patch: ChatSettingsPatch = {
        follower_mode: true,
        follower_mode_duration: duration,
      };
      validatePatch(patch);
      return { kind, label: `Followers-only ${duration} min`, patch };
    }
    const patch = { emote_mode: true };
    validatePatch(patch);
    return { kind, label: 'Emote-only', patch };
  });
}

function parseProfile(value: unknown, name: string): ProfileConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`profile ${name} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const fields = [
    'setpoint_msgs_per_s', 'window_s', 'dwell_s', 'release_hold_s',
    'release_ratio', 'sustain_ratio', 'warning_boost', 'warning_hold_s',
    'override_hold_s',
  ] as const;
  for (const field of fields) {
    if (typeof raw[field] !== 'number') throw new Error(`${name}.${field} must be a number`);
    positive(raw[field], `${name}.${field}`);
  }
  if ((raw.release_ratio as number) >= 1) {
    throw new Error(`${name}.release_ratio must be less than 1`);
  }
  if ((raw.sustain_ratio as number) > 1) {
    throw new Error(`${name}.sustain_ratio must be at most 1`);
  }
  const config: ProfileConfig = {
    setpoint_msgs_per_s: raw.setpoint_msgs_per_s as number,
    window_s: raw.window_s as number,
    dwell_s: raw.dwell_s as number,
    release_hold_s: raw.release_hold_s as number,
    release_ratio: raw.release_ratio as number,
    sustain_ratio: raw.sustain_ratio as number,
    warning_boost: raw.warning_boost as number,
    warning_hold_s: raw.warning_hold_s as number,
    override_hold_s: raw.override_hold_s as number,
    ladder: parseLadder(raw.ladder),
  };
  return config;
}

export async function loadConfig(
  profile = process.env.UNDERTOW_PROFILE ?? 'real',
  path: URL | string = DEFAULT_CONFIG_PATH,
): Promise<ProfileConfig> {
  if (profile !== 'real' && profile !== 'loadtest') {
    throw new Error('UNDERTOW_PROFILE must be real or loadtest');
  }
  const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<UndertowConfig>;
  return parseProfile(raw[profile], profile);
}

export function selectedProfile(args: string[]): string {
  const index = args.indexOf('--profile');
  if (index >= 0) {
    const profile = args[index + 1] ?? '';
    if (profile !== 'real' && profile !== 'loadtest') {
      throw new Error('Invalid --profile flag; choose real or loadtest');
    }
    return profile;
  }
  return process.env.UNDERTOW_PROFILE ?? 'real';
}
