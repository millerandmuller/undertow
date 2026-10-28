import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { runReplay, writeLastReplay, type ReplayResult } from './driver.ts';
import { loadReplay } from './replay.ts';

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? '';
}

function sameDecisions(left: ReplayResult, right: ReplayResult): boolean {
  return JSON.stringify(left.decisions) === JSON.stringify(right.decisions);
}

function firstDifference(left: ReplayResult, right: ReplayResult): string {
  const length = Math.max(left.decisions.length, right.decisions.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.decisions[index];
    const b = right.decisions[index];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return `first difference at decision ${index + 1}: ` +
        `${JSON.stringify(a ?? null)} != ${JSON.stringify(b ?? null)}`;
    }
  }
  return 'decision lists differ';
}

function countRate(events: number[], start: number, end: number): number {
  const count = events.filter((time) => time > start && time <= end).length;
  return count / ((end - start) / 1000);
}

function settingsMatchBaseline(result: ReplayResult): boolean {
  const current = result.finalSettings;
  const baseline = result.baseline;
  return current.slow_mode === baseline.slow_mode &&
    current.follower_mode === baseline.follower_mode &&
    current.emote_mode === baseline.emote_mode &&
    current.subscriber_mode === baseline.subscriber_mode &&
    current.unique_chat_mode === baseline.unique_chat_mode &&
    (!baseline.slow_mode || current.slow_mode_wait_time === baseline.slow_mode_wait_time) &&
    (!baseline.follower_mode ||
      current.follower_mode_duration === baseline.follower_mode_duration);
}

function report(result: ReplayResult, events: number[]): void {
  const moves = result.decisions.filter((item) => item.action !== 'none');
  for (const item of moves) {
    console.log(
      `${(item.offset_ms / 1000).toFixed(0)}s pace ${item.pace.toFixed(1)}/s, ` +
      `setpoint ${item.setpoint.toFixed(1)}/s, step ${item.step}, ` +
      `${item.action}: ${item.reason}`,
    );
  }
  const stepUps = result.decisions.filter((item) => item.action === 'step_up');
  const lastUp = stepUps.at(-1);
  const windowMs = result.profile.window_s * 1000;
  const before = lastUp
    ? countRate(events, lastUp.offset_ms - windowMs, lastUp.offset_ms)
    : 0;
  const after = lastUp
    ? countRate(events, lastUp.offset_ms, lastUp.offset_ms + windowMs)
    : 0;
  const peak = peakRate(events, windowMs);
  const restore = result.decisions.find((item) => item.action === 'restore');
  const restoredAt = restore
    ? ((restore.offset_ms - (lastUp?.offset_ms ?? 0)) / 1000).toFixed(0) + ' s'
    : 'not restored';
  const equal = settingsMatchBaseline(result);
  console.log(`summary peak ${peak.toFixed(1)} msgs/s`);
  console.log(`pace around final step-up ${before.toFixed(1)} before, ${after.toFixed(1)} after`);
  console.log(`steps taken ${stepUps.length}; time to restore after final step-up ${restoredAt}`);
  console.log(`final settings equal baseline: ${equal ? 'yes' : 'no'}`);
}

function peakRate(events: number[], windowMs: number): number {
  let peak = 0;
  for (const time of events) {
    peak = Math.max(peak, countRate(events, time - windowMs, time));
  }
  return peak;
}

async function runFreshSimulation(
  replay: Awaited<ReturnType<typeof loadReplay>>,
  profile: Awaited<ReturnType<typeof loadConfig>>,
  tailSeconds: number,
): Promise<ReplayResult> {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-replay-'));
  try {
    return await runReplay(replay, profile, directory, tailSeconds);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function replayCommand(args: string[]): Promise<void> {
  const file = args.find((value) => !value.startsWith('--'));
  if (!file) {
    throw new Error('Usage: node src/cli.ts replay <file> [--profile loadtest] [--runs 3]');
  }
  const profileName = option(args, '--profile', process.env.UNDERTOW_PROFILE ?? 'real');
  const runCount = Number(option(args, '--runs', '1'));
  if (!Number.isInteger(runCount) || runCount < 1 || runCount > 100) {
    throw new Error('--runs must be an integer from 1 to 100');
  }
  const tailSeconds = Number(option(args, '--tail', '90'));
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0) {
    throw new Error('--tail must be a non-negative number');
  }
  const replay = await loadReplay(file);
  const profile = await loadConfig(profileName);
  const stateDirectory = process.env.UNDERTOW_STATE_DIR ?? '.undertow';
  const events = replay.events
    .filter((item) => item.type === 'channel.chat.message')
    .map((item) => item.at_ms);
  console.log(`SIMULATION (replay of ${file}, no Twitch connection)`);
  let first: ReplayResult | null = null;
  let last: ReplayResult | null = null;
  for (let index = 0; index < runCount; index += 1) {
    const result = await runFreshSimulation(replay, profile, tailSeconds);
    if (first && !sameDecisions(first, result)) {
      console.error(firstDifference(first, result));
      process.exitCode = 1;
      return;
    }
    first ??= result;
    last = result;
  }
  if (!last) throw new Error('Replay did not run');
  report(last, events);
  await writeLastReplay(stateDirectory, last.decisions);
  console.log(`deterministic: ${runCount} of ${runCount} runs identical`);
}
