import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatSettings, ChatSettingsPatch } from '../actuator/settings.ts';
import { saveBaseline } from '../actuator/settings.ts';
import type { ProfileConfig } from '../config.ts';
import { startRun, type DisplayState, type RunLog } from '../run.ts';
import { SimulatedClock } from './clock.ts';
import { SimulatedChannel } from './channel.ts';
import { SimulatedSettingsPlayback } from './settings-playback.ts';
import {
  emitSimulatedEvent, forceSimulatedReconnect, resetSimulatedSockets,
  SimulatedSocketConstructor,
} from './socket.ts';
import { toUndertowEvent, type ReplayFile } from './replay.ts';
import {
  labelRateText,
  messagePassesModel,
  type ResponseModel,
} from './response-model.ts';

type ReplayDecision = RunLog & { offset_ms: number };
export type ReplayDriverOptions = {
  speed?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onDisplay?: (display: DisplayState) => Promise<void> | void;
  log?: (entry: unknown) => void;
};
export type ReplayResult = {
  decisions: ReplayDecision[];
  replies: { message: string; parent_id: string | null }[];
  patches: ChatSettingsPatch[];
  finalSettings: ChatSettings;
  baseline: ChatSettings;
  profile: ProfileConfig;
  recordedMessageOffsets: number[];
  simulatedMessageOffsets: number[];
  modeled: boolean;
};

function activeStep(channel: SimulatedChannel, profile: ProfileConfig): number {
  for (let index = profile.ladder.length - 1; index >= 0; index -= 1) {
    const patch = profile.ladder[index].patch;
    const matches = Object.entries(patch).every(([key, value]) =>
      channel.settings[key as keyof ChatSettings] === value);
    if (matches) return index + 1;
  }
  return 0;
}

export async function runReplay(
  replay: ReplayFile,
  profile: ProfileConfig,
  stateDirectory: string,
  tailSeconds = 90,
  reconnectAtMs?: number,
  responseModel: ResponseModel | null = null,
  options: ReplayDriverOptions = {},
): Promise<ReplayResult> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await rm(join(stateDirectory, 'storm.log.jsonl'), { force: true });
  await saveBaseline(join(stateDirectory, 'baseline.json'), replay.header.baseline);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const clock = new SimulatedClock(async (intervalMs) => {
    if (options.speed !== undefined) await sleep(intervalMs / options.speed);
  });
  resetSimulatedSockets();
  const channel = new SimulatedChannel(replay.header.baseline, () => clock.now());
  const settingsPlayback = new SimulatedSettingsPlayback(channel);
  const helix = channel.createHelix();
  const run = await startRun({
    helix,
    broadcasterId: replay.header.broadcaster_id,
    profile,
    stateDirectory,
    dryRun: false,
    mode: 'simulation',
    socketConstructor: SimulatedSocketConstructor,
    clock,
    log: options.log ?? (() => undefined),
  });
  const recordedMessageOffsets: number[] = [];
  const simulatedMessageOffsets: number[] = [];
  try {
    await options.onDisplay?.(run.display);
    let didReconnect = false;
    for (let index = 0; index < replay.events.length; index += 1) {
      const item = replay.events[index];
      await advanceReplayTo(item.at_ms);
      if (!didReconnect && reconnectAtMs !== undefined && item.at_ms >= reconnectAtMs) {
        forceSimulatedReconnect();
        didReconnect = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (item.type === 'channel.chat_settings.update') {
        settingsPlayback.accept(item, index);
      } else if (item.type === 'channel.chat.message') {
        recordedMessageOffsets.push(item.at_ms);
        const fraction = responseModel?.pass_through_by_step[activeStep(channel, profile)];
        if (fraction === undefined || messagePassesModel(item.at_ms, index, fraction)) {
          simulatedMessageOffsets.push(item.at_ms);
          emitSimulatedEvent(toUndertowEvent(item, index));
        }
      } else {
        emitSimulatedEvent(toUndertowEvent(item, index));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const endMs = replay.events.at(-1)?.at_ms ?? 0;
    await advanceReplayTo(endMs + tailSeconds * 1000);
    while (settingsPlayback.nextDeadline() !== null) {
      await advanceReplayTo(settingsPlayback.nextDeadline()!);
    }
  } finally {
    await run.stop();
  }
  async function advanceReplayTo(targetMs: number): Promise<void> {
    let deadline = settingsPlayback.nextDeadline();
    while (deadline !== null && deadline <= targetMs) {
      await clock.advanceTo(Math.max(clock.now(), deadline));
      if (settingsPlayback.flush(clock.now()) > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      deadline = settingsPlayback.nextDeadline();
    }
    await clock.advanceTo(targetMs);
    if (settingsPlayback.flush(clock.now()) > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const logPath = join(stateDirectory, 'storm.log.jsonl');
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  const decisions = lines.filter(Boolean).map((line) => {
    const log = JSON.parse(line) as RunLog;
    return { ...log, offset_ms: Date.parse(log.t) };
  });
  return {
    decisions,
    replies: channel.replies,
    patches: channel.patches,
    finalSettings: channel.settings,
    baseline: replay.header.baseline,
    profile,
    recordedMessageOffsets,
    simulatedMessageOffsets,
    modeled: responseModel !== null,
  };
}

export async function writeLastReplay(
  stateDirectory: string,
  decisions: ReplayDecision[],
  paceSource: 'modeled' | 'recorded',
): Promise<void> {
  const path = join(stateDirectory, 'replay.last.jsonl');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const rows = decisions.map((decision) => {
    const { offset_ms: _offset, ...log } = decision;
    return JSON.stringify({
      t: log.t,
      pace: log.pace,
      pace_source: paceSource,
      setpoint: log.setpoint,
      step: log.step,
      action: log.action,
      reason: labelRateText(log.reason, paceSource),
      reply_id: log.reply_id,
      ratelimit_remaining: log.ratelimit_remaining,
    });
  });
  await writeFile(path, `${rows.join('\n')}\n`, { mode: 0o600 });
}
