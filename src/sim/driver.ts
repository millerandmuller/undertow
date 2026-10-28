import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatSettings, ChatSettingsPatch } from '../actuator/settings.ts';
import { saveBaseline } from '../actuator/settings.ts';
import type { ProfileConfig } from '../config.ts';
import type { ChatSettingsNotification } from '../eventsub/client.ts';
import { startRun, type RunLog } from '../run.ts';
import { SimulatedClock } from './clock.ts';
import { SimulatedChannel } from './channel.ts';
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
): Promise<ReplayResult> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await rm(join(stateDirectory, 'storm.log.jsonl'), { force: true });
  await saveBaseline(join(stateDirectory, 'baseline.json'), replay.header.baseline);
  const clock = new SimulatedClock();
  resetSimulatedSockets();
  const channel = new SimulatedChannel(replay.header.baseline);
  const helix = channel.createHelix();
  const run = await startRun({
    helix,
    broadcasterId: replay.header.broadcaster_id,
    profile,
    stateDirectory,
    dryRun: false,
    socketConstructor: SimulatedSocketConstructor,
    clock,
    log: () => undefined,
  });
  let didReconnect = false;
  const recordedMessageOffsets: number[] = [];
  const simulatedMessageOffsets: number[] = [];
  for (let index = 0; index < replay.events.length; index += 1) {
    const item = replay.events[index];
    await clock.advanceTo(item.at_ms);
    if (!didReconnect && reconnectAtMs !== undefined && item.at_ms >= reconnectAtMs) {
      forceSimulatedReconnect();
      didReconnect = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (item.type === 'channel.chat_settings.update') {
      channel.applyRecordedSettings(item.event as ChatSettingsNotification);
    }
    if (item.type === 'channel.chat.message') {
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
  await clock.advanceTo(endMs + tailSeconds * 1000);
  await run.stop();
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
