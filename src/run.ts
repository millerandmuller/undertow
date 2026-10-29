import { access, appendFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  chatSettings,
  saveBaseline,
  type ChatSettings,
  type ChatSettingsPatch,
} from './actuator/settings.ts';
import { ChatSender } from './chat/send.ts';
import type { ProfileConfig } from './config.ts';
import {
  decide,
  initialControllerState,
  type ControllerAction,
  type ControllerState,
} from './controller/controller.ts';
import { createPaceState, rate, record, type PaceState } from './controller/pace.ts';
import {
  actionNotice,
  warningNotice,
  type Notice,
} from './notices/notices.ts';
import {
  EventSub,
  type EventSubSocketConstructor,
  type ChatMessageNotification,
  type ChatNotification,
  type ChatSettingsNotification,
  type EventSubEvent,
  type RaidNotification,
  type UndertowEvent,
} from './eventsub/client.ts';
import { readJson } from './util/files.ts';
import { readLoadtestBadge } from './loadtest/state.ts';
import type { Helix } from './util/helix.ts';
import type { ReplayEvent, ReplayHeader, ReplayType } from './sim/replay.ts';

type DisplayListener = (state: DisplayState) => void;
export type DisplayState = {
  pace: number;
  setpoint: number;
  step: number;
  mode: 'dry' | 'live' | 'simulation';
  stepLabel: string;
  stepCount: number;
  warning: 'gift' | 'raid' | null;
  warningHoldSeconds: number;
  ratelimitRemaining: number | null;
  ratelimitLimit: number | null;
  paceSource: 'measured' | 'modeled';
  badge: string | null;
  lastReason: string;
  subscribe(listener: DisplayListener): () => void;
  publish(next: Pick<DisplayState, 'pace' | 'setpoint' | 'step' | 'lastReason'> &
    Partial<Pick<DisplayState,
      'mode' | 'stepLabel' | 'stepCount' | 'warning' | 'ratelimitRemaining' |
      'ratelimitLimit' | 'paceSource' | 'badge' | 'warningHoldSeconds'>>): void;
};

export function createDisplayState(
  setpoint: number,
  mode: DisplayState['mode'] = 'dry',
): DisplayState {
  const listeners = new Set<DisplayListener>();
  const display: DisplayState = {
    pace: 0,
    setpoint,
    step: 0,
    mode,
    stepLabel: 'normal',
    stepCount: 5,
    warning: null,
    warningHoldSeconds: 0,
    ratelimitRemaining: null,
    ratelimitLimit: null,
    paceSource: 'measured',
    badge: null,
    lastReason: 'waiting for chat',
    subscribe(listener) {
      listeners.add(listener);
      listener(display);
      return () => listeners.delete(listener);
    },
    publish(next) {
      Object.assign(display, next);
      for (const listener of listeners) listener(display);
    },
  };
  return display;
}

export type RunClock = {
  now(): number;
  every(intervalMs: number, callback: () => Promise<void>): () => void;
};

const SYSTEM_CLOCK: RunClock = {
  now: Date.now,
  every(intervalMs, callback) {
    const timer = setInterval(() => { void callback(); }, intervalMs);
    return () => clearInterval(timer);
  },
};

export type RunOptions = {
  helix: Helix;
  broadcasterId: string;
  profile: ProfileConfig;
  stateDirectory: string;
  dryRun: boolean;
  log?: (entry: unknown) => void;
  socketConstructor?: EventSubSocketConstructor;
  verbose?: boolean;
  clock?: RunClock;
  recordPath?: string;
  delay?: (milliseconds: number) => Promise<void>;
  mode?: 'real' | 'simulation';
};

export type RunHandle = {
  display: DisplayState;
  done: Promise<void>;
  stop(): Promise<void>;
  readonly exitCode: number;
};
export type RunLog = {
  t: string;
  pace: number;
  pace_source: 'recorded';
  setpoint: number;
  step: number;
  action: string;
  reason: string;
  reply_id: string | null;
  ratelimit_remaining: string | null;
};

const PATCH_KEYS: (keyof ChatSettings)[] = [
  'slow_mode', 'slow_mode_wait_time', 'follower_mode', 'follower_mode_duration',
  'emote_mode', 'subscriber_mode', 'unique_chat_mode',
];

function eventPatch(event: ChatSettingsNotification): ChatSettingsPatch {
  const patch: ChatSettingsPatch = {};
  for (const key of PATCH_KEYS) {
    const alias = key === 'slow_mode_wait_time'
      ? event.slow_mode_wait_time_seconds
      : key === 'follower_mode_duration'
      ? event.follower_mode_duration_minutes
      : undefined;
    const value = alias ?? event[key];
    if (value !== undefined) Object.assign(patch, { [key]: value });
  }
  return patch;
}

function matchesExpected(patch: ChatSettingsPatch, expected: ChatSettings): boolean {
  const keys = Object.keys(patch) as (keyof ChatSettings)[];
  return keys.length > 0 && keys.every((key) => patch[key] === expected[key]);
}

function patchSnapshot(current: ChatSettings, patch: ChatSettingsPatch): ChatSettings {
  return { ...current, ...patch };
}

function actionPatch(
  action: ControllerAction,
  profile: ProfileConfig,
  currentStep: number,
): ChatSettingsPatch | null {
  if (action.type === 'step_up' || action.type === 'step_down') {
    const targetPatch = profile.ladder[action.step - 1]?.patch;
    if (!targetPatch) return null;
    const patch = { ...targetPatch };
    if (action.type === 'step_down') {
      for (let level = currentStep; level > action.step; level -= 1) {
        const kind = profile.ladder[level - 1]?.kind;
        if (kind === 'emote') patch.emote_mode = false;
        if (kind === 'followers') patch.follower_mode = false;
      }
    }
    return patch;
  }
  return null;
}

function reasonFor(action: ControllerAction, notice: Notice | null): string {
  if (notice) return notice.message;
  if (action.type === 'yield') return 'manual override';
  if (action.type === 'none') return 'holding current settings';
  if (action.type === 'step_down') return `step down to ${action.step}`;
  return `step up to ${action.step}`;
}

async function writeLog(path: string, entry: RunLog): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function isGift(event: ChatNotification): boolean {
  return event.notice_type.includes('gift');
}

function isReplayType(type: string): type is ReplayType {
  return type === 'channel.chat.message' || type === 'channel.chat.notification' ||
    type === 'channel.chat_settings.update' || type === 'channel.raid';
}

function recordedPayload(event: UndertowEvent): EventSubEvent {
  if (event.type === 'channel.chat.message') {
    const message = event.event as ChatMessageNotification;
    return {
      broadcaster_user_id: message.broadcaster_user_id,
      chatter_user_id: message.chatter_user_id,
      message_id: message.message_id,
      message: { text: `<${message.message.text.length} chars>` },
    };
  }
  if (event.type === 'channel.chat.notification') {
    const notice = event.event as ChatNotification;
    return {
      broadcaster_user_id: notice.broadcaster_user_id,
      chatter_user_id: notice.chatter_user_id,
      notice_type: notice.notice_type,
    };
  }
  if (event.type === 'channel.raid') {
    const raid = event.event as RaidNotification;
    return {
      from_broadcaster_user_id: raid.from_broadcaster_user_id,
      to_broadcaster_user_id: raid.to_broadcaster_user_id,
      viewers: raid.viewers,
    };
  }
  return structuredClone(event.event);
}

function isRawEvent(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const value = entry as Record<string, unknown>;
  return typeof value.type === 'string' && value.type.startsWith('channel.') &&
    typeof value.message_id === 'string';
}

function rateText(value: number): string {
  return String(Number(value.toFixed(1)));
}

function stepLabel(step: number, profile: ProfileConfig): string {
  if (step === 0) return 'normal';
  const current = profile.ladder[step - 1];
  if (!current) return 'normal';
  if (current.kind === 'slow') {
    return `slow ${current.patch.slow_mode_wait_time} s`;
  }
  if (current.kind === 'followers') {
    return `followers ${current.patch.follower_mode_duration} min`;
  }
  return 'emote only';
}

function rateLimitValue(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function statusLine(
  display: DisplayState,
  profile: ProfileConfig,
  dryRun: boolean,
  warning: 'gift' | 'raid' | null,
): string {
  const marker = warning ? `warning: ${warning}, ` : '';
  const overlay = `pace ${rateText(display.pace)}/s, ` +
    `setpoint ${rateText(display.setpoint)}/s, ` +
    `step ${display.step} of ${profile.ladder.length}`;
  return `${marker}${overlay} (${dryRun ? 'dry' : 'live'})`;
}

function activeSetpoint(
  nowMs: number,
  warningAt: number | null,
  profile: ProfileConfig,
): number {
  const warningActive = warningAt !== null &&
    nowMs - warningAt <= profile.warning_hold_s * 1000;
  return warningActive
    ? profile.setpoint_msgs_per_s / profile.warning_boost
    : profile.setpoint_msgs_per_s;
}

function isLoginFailure(message: string): boolean {
  return /^Helix request failed \(401\):/.test(message) ||
    /^Token refresh failed \(401\)$/.test(message);
}

export async function startRun(options: RunOptions): Promise<RunHandle> {
  const logger = options.log ?? console.log;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const settingsApi = chatSettings(options.helix, options.broadcasterId);
  const baselinePath = join(options.stateDirectory, 'baseline.json');
  const logPath = join(options.stateDirectory, 'storm.log.jsonl');
  let recordQueue = Promise.resolve();
  let eventQueue = Promise.resolve();
  let baseline: ChatSettings;
  if (!options.dryRun && options.mode !== 'simulation') {
    try {
      await access(baselinePath);
      throw new Error('unrestored previous run: run npm run restore first');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('unrestored')) throw error;
    }
  }
  try {
    await access(baselinePath);
    baseline = await readJson<ChatSettings>(baselinePath);
  } catch {
    baseline = await settingsApi.get();
    await saveBaseline(baselinePath, baseline);
  }
  let expected = await settingsApi.get();
  const controllerOwned = new Set<keyof ChatSettings>();
  const runStartedAt = clock.now();
  if (options.recordPath) {
    await mkdir(dirname(options.recordPath), { recursive: true, mode: 0o700 });
    const header: ReplayHeader = {
      kind: 'header',
      version: 1,
      label: 'recorded Undertow run',
      synthetic: false,
      broadcaster_id: options.broadcasterId,
      baseline,
    };
    await writeFile(options.recordPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  }
  let paceState: PaceState = createPaceState(options.profile.window_s);
  let controller: ControllerState = initialControllerState();
  let warningAt: number | null = null;
  let warningKind: 'gift' | 'raid' | null = null;
  let overrideUntilMs = 0;
  let lastMessageId: string | null = null;
  const sentMessageIds = new Set<string>();
  const sentMessageOrder: string[] = [];
  let lastReplyParentId: string | null = null;
  let stopped = false;
  let paused = false;
  let authRetryAtMs = 0;
  let exitCode = 0;
  const delay = options.delay ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let retryAfterMs = 0;
  let cancelTicks: (() => void) | undefined;
  let tickInFlight: Promise<void> | null = null;
  let resolveDone: (() => void) = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const display = createDisplayState(
    options.profile.setpoint_msgs_per_s,
    options.dryRun ? 'dry' : 'live',
  );
  let nextStatusAtMs = clock.now() + options.profile.window_s * 1000;
  const sender = new ChatSender(options.helix, options.broadcasterId, {
    now: () => clock.now(),
    log: logger,
  });

  const restore = async (): Promise<void> => {
    if (options.dryRun) return;
    let failure: unknown;
    for (const waitMs of [0, 1000, 2000, 4000]) {
      if (waitMs > 0) await delay(waitMs);
      try {
        await restoreOwnedSettings();
        await unlink(baselinePath).catch(() => undefined);
        return;
      } catch (error) {
        failure = error;
      }
    }
    exitCode = 1;
    logger('RESTORE FAILED: run npm run restore now');
    throw failure instanceof Error ? failure : new Error('Restore failed');
  };

  const restoreOwnedSettings = async (): Promise<void> => {
    const actual = await settingsApi.get();
    const patch: ChatSettingsPatch = {};
    const owns = (key: keyof ChatSettings): boolean => controllerOwned.has(key) &&
      actual[key] === expected[key];
    const slowOwned = controllerOwned.has('slow_mode') ||
      controllerOwned.has('slow_mode_wait_time');
    const slowChangedByHand = (controllerOwned.has('slow_mode') &&
      actual.slow_mode !== expected.slow_mode) ||
      (controllerOwned.has('slow_mode_wait_time') &&
      actual.slow_mode_wait_time !== expected.slow_mode_wait_time);
    if (slowOwned && !slowChangedByHand) {
        patch.slow_mode = baseline.slow_mode;
      if (baseline.slow_mode && controllerOwned.has('slow_mode_wait_time')) {
        patch.slow_mode_wait_time = baseline.slow_mode_wait_time;
      }
    }
    const followersOwned = controllerOwned.has('follower_mode') ||
      controllerOwned.has('follower_mode_duration');
    const followersChangedByHand = (controllerOwned.has('follower_mode') &&
      actual.follower_mode !== expected.follower_mode) ||
      (controllerOwned.has('follower_mode_duration') &&
      actual.follower_mode_duration !== expected.follower_mode_duration);
    if (followersOwned && !followersChangedByHand) {
      patch.follower_mode = baseline.follower_mode;
      if (baseline.follower_mode && controllerOwned.has('follower_mode_duration')) {
        patch.follower_mode_duration = baseline.follower_mode_duration;
      }
    }
    if (owns('emote_mode')) patch.emote_mode = baseline.emote_mode;
    const previousExpected = expected;
    expected = patchSnapshot(expected, patch);
    try {
      if (Object.keys(patch).length > 0) await settingsApi.update(patch);
    } catch (error) {
      expected = previousExpected;
      throw error;
    }
    const verified = await settingsApi.get();
    for (const key of Object.keys(patch) as (keyof ChatSettings)[]) {
      if (verified[key] !== patch[key]) throw new Error(`Restore verification failed for ${key}`);
    }
    controllerOwned.clear();
    expected = verified;
  };

  const eventSub = new EventSub(
    options.helix,
    options.broadcasterId,
    (event) => {
      eventQueue = eventQueue.then(() => processEvent(event));
    },
    options.socketConstructor ?? WebSocket,
    (entry) => {
      if (!isRawEvent(entry) || options.verbose) logger(entry);
    },
    {
      onFatal: () => {
        exitCode = 1;
        void stop();
      },
    },
  );

  let stopOperation: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopOperation) return stopOperation;
    stopped = true;
    cancelTicks?.();
    eventSub.close();
    stopOperation = (async () => {
      try {
        if (tickInFlight) await tickInFlight.catch(() => undefined);
        await eventQueue.catch(() => undefined);
        await recordQueue.catch(() => undefined);
        await restore();
      } catch (error) {
        logger({ type: 'restore_failed', message: errorMessage(error) });
      } finally {
        resolveDone();
      }
    })();
    return stopOperation;
  };

  async function sendNotice(notice: Notice | null): Promise<string | null> {
    if (!notice || options.dryRun || !lastMessageId) return null;
    const parentId = sentMessageIds.has(lastMessageId) ? undefined : lastMessageId;
    const result = await sender.send(notice.message, parentId);
    if (result.is_sent && result.message_id) rememberSentId(result.message_id);
    return result.is_sent ? parentId ?? null : null;
  }

  function rememberSentId(messageId: string): void {
    if (sentMessageIds.has(messageId)) return;
    sentMessageIds.add(messageId);
    sentMessageOrder.push(messageId);
    if (sentMessageOrder.length > 20) {
      const expired = sentMessageOrder.shift();
      if (expired) sentMessageIds.delete(expired);
    }
  }

  async function processManualSettings(event: ChatSettingsNotification): Promise<void> {
    const patch = eventPatch(event);
    if (matchesExpected(patch, expected)) return;
    const nowMs = clock.now();
    overrideUntilMs = nowMs + options.profile.override_hold_s * 1000;
    controller = { ...initialControllerState(), lastMoveMs: nowMs };
    for (const key of Object.keys(patch) as (keyof ChatSettings)[]) {
      const value = patch[key];
      if (value !== undefined) {
        Object.assign(expected, { [key]: value });
        Object.assign(baseline, { [key]: value });
      }
      controllerOwned.delete(key);
      if (key === 'slow_mode' || key === 'slow_mode_wait_time') {
        controllerOwned.delete('slow_mode');
        controllerOwned.delete('slow_mode_wait_time');
      }
      if (key === 'follower_mode' || key === 'follower_mode_duration') {
        controllerOwned.delete('follower_mode');
        controllerOwned.delete('follower_mode_duration');
      }
    }
    await saveBaseline(baselinePath, baseline);
    logger({ type: 'manual_settings_change', override_until_ms: overrideUntilMs });
  }

  async function pauseForLogin(): Promise<void> {
    paused = true;
    authRetryAtMs = clock.now() + 60_000;
    logger({ type: 'login_needed' });
    try {
      await restore();
      controller = { ...initialControllerState(), lastMoveMs: clock.now() };
    } catch {
      // The restore path already logged the required loud failure.
    }
  }

  async function processEvent(event: UndertowEvent): Promise<void> {
    try {
      const nowMs = clock.now();
      if (options.recordPath) {
        recordQueue = recordQueue.then(() => recordEvent(event, nowMs));
        await recordQueue;
      }
      if (event.type === 'channel.chat.message') {
        const message = event.event as ChatMessageNotification;
        lastMessageId = message.message_id;
        paceState = record(paceState, nowMs);
      } else if (event.type === 'channel.chat.notification') {
        const notice = event.event as ChatNotification;
        if (isGift(notice)) {
          warningAt = nowMs;
          warningKind = 'gift';
          const notice = warningNotice(
            'gift',
            rate(paceState, nowMs),
            controller.step,
            options.profile,
          );
          await sendNotice(notice);
        }
      } else if (event.type === 'channel.raid') {
        warningAt = nowMs;
        warningKind = 'raid';
        const notice = warningNotice(
          'raid',
          rate(paceState, nowMs),
          controller.step,
          options.profile,
        );
        await sendNotice(notice);
      } else if (event.type === 'channel.chat_settings.update') {
        await processManualSettings(event.event as ChatSettingsNotification);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (isLoginFailure(message)) {
        await pauseForLogin();
      } else {
        exitCode = 1;
        logger({ type: 'event_error', message });
        void stop();
      }
    }
  }

  async function recordEvent(event: UndertowEvent, nowMs: number): Promise<void> {
    if (!options.recordPath || !isReplayType(event.type)) return;
    const safeEvent = recordedPayload(event);
    const item: ReplayEvent = {
      kind: 'event',
      at_ms: Math.max(0, nowMs - runStartedAt),
      type: event.type,
      event: safeEvent,
    };
    await appendFile(options.recordPath, `${JSON.stringify(item)}\n`);
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unexpected run error';
  }

  async function apply(action: ControllerAction): Promise<void> {
    if (options.dryRun || action.type === 'none' || action.type === 'yield') return;
    if (action.type === 'restore') {
      await restore();
      return;
    }
    const patch = actionPatch(action, options.profile, controller.step);
    if (!patch) return;
    if (controllerOwned.size === 0) await saveBaseline(baselinePath, baseline);
    const previousExpected = expected;
    const previousOwned = new Set(controllerOwned);
    expected = patchSnapshot(expected, patch);
    for (const key of Object.keys(patch) as (keyof ChatSettings)[]) {
      controllerOwned.add(key);
    }
    try {
      await settingsApi.update(patch);
    } catch (error) {
      expected = previousExpected;
      controllerOwned.clear();
      for (const key of previousOwned) controllerOwned.add(key);
      throw error;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const nowMs = clock.now();
    const pace = rate(paceState, nowMs);
    if (paused && nowMs >= authRetryAtMs) {
      try {
        await settingsApi.get();
        paused = false;
        authRetryAtMs = 0;
        logger({ type: 'login_resumed' });
      } catch (error) {
        if (isLoginFailure(errorMessage(error))) authRetryAtMs = nowMs + 60_000;
        else throw error;
      }
    }
    const decision = paused
      ? { state: controller, action: { type: 'yield' as const } }
      : nowMs < retryAfterMs
      ? { state: controller, action: { type: 'none' as const } }
      : decide(controller, {
        nowMs,
        rate: pace,
        warnings: warningAt,
        manualOverrideUntilMs: overrideUntilMs,
      }, options.profile);
    const notice = actionNotice(decision.action, options.profile, pace);
    lastReplyParentId = null;
    let reason = paused ? 'login needed' : reasonFor(decision.action, notice);
    if (!paused && lastMessageId === null && decision.action.type === 'none') {
      reason = 'waiting for chat';
    }
    if (!paused && nowMs < retryAfterMs) reason = 'waiting before retrying failed setting change';
    if (decision.action.type === 'none' || decision.action.type === 'yield') {
      controller = decision.state;
    } else {
      if (options.dryRun) logger({ type: 'dry_action', action: decision.action });
      try {
        await apply(decision.action);
        controller = decision.state;
        if (notice) {
          try {
            lastReplyParentId = await sendNotice(notice);
          } catch (error) {
            const message = errorMessage(error);
            if (isLoginFailure(message)) {
              await pauseForLogin();
              reason = 'login needed';
            } else {
              reason = `settings changed; reply failed: ${message}`;
              logger({ type: 'reply_failed', message });
            }
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        if (isLoginFailure(message)) {
          await pauseForLogin();
          reason = 'login needed';
        } else {
          retryAfterMs = nowMs + options.profile.dwell_s * 1000;
          reason = `setting change failed: ${message}`;
          logger({ type: 'action_failed', message });
        }
      }
    }
    const setpoint = activeSetpoint(nowMs, warningAt, options.profile);
    const badge = await readLoadtestBadge(
      join(options.stateDirectory, 'loadtest.state.json'),
      nowMs,
    );
    const warningActive = warningAt !== null &&
      nowMs - warningAt <= options.profile.warning_hold_s * 1000;
    display.publish({
      pace,
      setpoint,
      step: controller.step,
      lastReason: reason,
      mode: options.dryRun ? 'dry' : 'live',
      stepLabel: stepLabel(controller.step, options.profile),
      stepCount: options.profile.ladder.length,
      warning: warningActive ? warningKind : null,
      warningHoldSeconds: options.profile.warning_hold_s,
      ratelimitRemaining: rateLimitValue(options.helix.remaining),
      ratelimitLimit: rateLimitValue(options.helix.limit),
      paceSource: 'measured',
      badge,
    });
    await writeLog(logPath, {
      t: new Date(nowMs).toISOString(),
      pace,
      pace_source: 'recorded',
      setpoint,
      step: controller.step,
      action: options.dryRun ? `dry_${decision.action.type}` : decision.action.type,
      reason,
      reply_id: lastReplyParentId,
      ratelimit_remaining: options.helix.remaining,
    });
    if (nowMs >= nextStatusAtMs) {
      const activeWarning = warningAt !== null &&
        nowMs - warningAt <= options.profile.warning_hold_s * 1000;
      logger(statusLine(
        display,
        options.profile,
        options.dryRun,
        activeWarning ? warningKind : null,
      ));
      nextStatusAtMs = nowMs + options.profile.window_s * 1000;
    }
  }

  await eventSub.connect();
  cancelTicks = clock.every(1000, async () => {
    if (tickInFlight || stopped) return;
    tickInFlight = tick();
    try {
      await tickInFlight;
    } catch (error) {
      exitCode = 1;
      logger({ type: 'fatal_run_error', message: errorMessage(error) });
      await stop();
    } finally {
      tickInFlight = null;
    }
  });
  return {
    display,
    done,
    stop,
    get exitCode() { return exitCode; },
  };
}
