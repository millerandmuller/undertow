import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Helix } from '../util/helix.ts';
import { atomicJson } from '../util/files.ts';
import {
  intervalMs,
  rateAt,
  RollingMessageLimiter,
  type LoadtestRate,
} from './scheduler.ts';

export type SenderAccount = {
  login: string;
  userId: string;
  helix: Helix;
};

export type LoadtestClock = {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<boolean>;
};

export type LoadtestOptions = {
  accounts: SenderAccount[];
  broadcasterId: string;
  channelLogin: string;
  stateDirectory: string;
  lines: string[];
  rate: LoadtestRate;
  signal?: AbortSignal;
  countdownSeconds?: number;
  clock?: LoadtestClock;
  output?: (line: string) => void;
};

type MessageResponse = {
  data: { is_sent: boolean; drop_reason: { code: string } | null }[];
};

type SendOutcome = {
  accepted: boolean;
  dropReason: string | null;
  requestError: boolean;
};

type MessageRecord = {
  time: string;
  elapsed_s: number;
  login: string;
  accepted: boolean;
  drop_reason: string | null;
  line_index: number;
};

type StormRecord = { t: string; action: string };

const SYSTEM_CLOCK: LoadtestClock = {
  now: Date.now,
  sleep: sleepWithSignal,
};

export async function runLoadtest(options: LoadtestOptions): Promise<void> {
  if (options.accounts.length === 0) {
    throw new Error('At least one load-test account is required');
  }
  if (options.lines.length === 0) {
    throw new Error('At least one scripted line is required');
  }
  const output = options.output ?? console.log;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const statePath = join(options.stateDirectory, 'loadtest.state.json');
  const logPath = join(options.stateDirectory, 'loadtest.log.jsonl');
  await prepareFiles(options.stateDirectory, logPath);
  await countdown(options.countdownSeconds ?? 5, clock, options.signal, output);
  const startedAt = clock.now();
  const nextTimes = initialTimes(options.accounts, startedAt, options.rate.rate);
  const sequence = options.accounts.map(() => 0);
  const limiters = options.accounts.map(() => new RollingMessageLimiter());
  const records: MessageRecord[] = [];
  const drops: Record<string, number> = {};
  let attempted = 0;
  let accepted = 0;
  let requestErrors = 0;
  let nextStateAt = startedAt;
  const endAt = startedAt +
    (options.rate.burstSeconds + options.rate.taperSeconds) * 1000;
  await writeState(statePath, true, options.accounts.length, options.rate.rate, clock.now());

  let finishedAt = startedAt;
  try {
    while (!options.signal?.aborted) {
      const now = clock.now();
      if (now >= nextStateAt) {
        await writeState(
          statePath,
          true,
          options.accounts.length,
          options.rate.rate,
          now,
        );
        nextStateAt = now + 1000;
      }
      const due = earliestDue(nextTimes);
      const wakeAt = Math.min(due?.at ?? endAt, nextStateAt, endAt);
      if (wakeAt > now) {
        const slept = await clock.sleep(wakeAt - now, options.signal);
        if (!slept) break;
        continue;
      }
      if (!due || due.at > endAt || now >= endAt) break;
      const elapsed = Math.max(0, (now - startedAt) / 1000);
      const currentRate = rateAt(elapsed, options.rate);
      if (currentRate <= 0) break;
      const limiter = limiters[due.index];
      const allowedAt = limiter?.nextAllowedAt(now) ?? now;
      if (allowedAt > now) {
        nextTimes[due.index] = allowedAt;
        continue;
      }
      const account = options.accounts[due.index];
      if (!account || !limiter) break;
      const lineIndex = attempted % options.lines.length;
      const line = options.lines[lineIndex] ?? '';
      const message = `[load test] ${line}`;
      attempted += 1;
      const result = await send(account, options.broadcasterId, message);
      const completedAt = clock.now();
      limiter.record(completedAt);
      const record: MessageRecord = {
        time: new Date(completedAt).toISOString(),
        elapsed_s: Math.max(0, (completedAt - startedAt) / 1000),
        login: account.login,
        accepted: result.accepted,
        drop_reason: result.dropReason,
        line_index: lineIndex,
      };
      records.push(record);
      if (result.requestError) requestErrors += 1;
      if (result.accepted) accepted += 1;
      else if (result.dropReason) {
        drops[result.dropReason] = (drops[result.dropReason] ?? 0) + 1;
      }
      await appendFile(logPath, `${JSON.stringify(record)}\n`);
      const currentSequence = sequence[due.index] ?? 0;
      sequence[due.index] = currentSequence + 1;
      const delay = intervalMs(account.login, currentSequence, currentRate);
      nextTimes[due.index] = clock.now() + delay;
    }
  } finally {
    finishedAt = clock.now();
    await writeState(
      statePath,
      false,
      options.accounts.length,
      options.rate.rate,
      finishedAt,
    );
  }
  await printSummary(
    options,
    records,
    attempted,
    accepted,
    requestErrors,
    drops,
    startedAt,
    finishedAt,
    output,
  );
}

async function send(
  account: SenderAccount,
  broadcasterId: string,
  message: string,
): Promise<SendOutcome> {
  try {
    const response = await account.helix.request('chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: account.userId,
        message,
      }),
    }) as MessageResponse;
    const result = response.data[0];
    if (!result) {
      return { accepted: false, dropReason: null, requestError: true };
    }
    return {
      accepted: result.is_sent,
      dropReason: result.is_sent ? null : result.drop_reason?.code ?? 'unknown',
      requestError: false,
    };
  } catch {
    return { accepted: false, dropReason: null, requestError: true };
  }
}

function initialTimes(
  accounts: SenderAccount[],
  startedAt: number,
  rate: number,
): number[] {
  const stagger = Math.min(1000 / rate / Math.max(accounts.length, 1), 1000);
  return accounts.map((_account, index) => startedAt + index * stagger);
}

function earliestDue(times: number[]): { index: number; at: number } | null {
  let earliest: { index: number; at: number } | null = null;
  times.forEach((at, index) => {
    if (earliest === null || at < earliest.at) earliest = { index, at };
  });
  return earliest;
}

async function countdown(
  seconds: number,
  clock: LoadtestClock,
  signal: AbortSignal | undefined,
  output: (line: string) => void,
): Promise<void> {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    if (signal?.aborted) return;
    output(`starting in ${remaining}...`);
    if (!await clock.sleep(1000, signal)) return;
  }
}

async function prepareFiles(directory: string, logPath: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(logPath, '', { mode: 0o600 });
}

async function writeState(
  path: string,
  active: boolean,
  accounts: number,
  rate: number,
  nowMs: number,
): Promise<void> {
  await atomicJson(path, {
    active,
    accounts,
    rate_per_account: rate,
    updated_at: new Date(nowMs).toISOString(),
  });
}

async function printSummary(
  options: LoadtestOptions,
  records: MessageRecord[],
  attempted: number,
  accepted: number,
  requestErrors: number,
  drops: Record<string, number>,
  startedAt: number,
  finishedAt: number,
  output: (line: string) => void,
): Promise<void> {
  output('load test summary');
  output(`accounts used: ${options.accounts.length}`);
  const dropped = Object.values(drops).reduce((total, count) => total + count, 0);
  output(`attempted: ${attempted}; accepted: ${accepted}; dropped: ${dropped}`);
  output(`dropped by reason: ${JSON.stringify(drops)}; request errors: ${requestErrors}`);
  for (const bucket of rateBuckets(records, options.rate)) output(bucket);
  await printObservedComparison(
    options.stateDirectory,
    records,
    startedAt,
    finishedAt,
    output,
  );
}

function rateBuckets(records: MessageRecord[], plan: LoadtestRate): string[] {
  const buckets: string[] = [];
  addPhaseBuckets(buckets, records, 'burst', 0, plan.burstSeconds);
  addPhaseBuckets(buckets, records, 'taper', plan.burstSeconds, plan.taperSeconds);
  return buckets;
}

function addPhaseBuckets(
  output: string[],
  records: MessageRecord[],
  phase: string,
  phaseStart: number,
  duration: number,
): void {
  for (let start = 0; start < duration; start += 10) {
    const length = Math.min(10, duration - start);
    const from = phaseStart + start;
    const until = from + length;
    const count = records.filter((record) => record.accepted &&
      record.elapsed_s >= from && record.elapsed_s < until).length;
    output.push(`${phase} ${start}-${start + length}s: ${count} accepted, ` +
      `${(count / length).toFixed(2)}/s`);
  }
}

async function printObservedComparison(
  stateDirectory: string,
  records: MessageRecord[],
  startedAt: number,
  finishedAt: number,
  output: (line: string) => void,
): Promise<void> {
  const stormPath = join(stateDirectory, 'storm.log.jsonl');
  const storm = await readStorm(stormPath);
  const moves = storm.filter((entry) => entry.action === 'step_up')
    .map((entry) => Date.parse(entry.t))
    .filter((time) => Number.isFinite(time) && time >= startedAt && time <= finishedAt);
  if (moves.length === 0) {
    output('no step_up in storm log; observed comparison unavailable');
    return;
  }
  const acceptedAt = records.filter((record) => record.accepted)
    .map((record) => Date.parse(record.time));
  output(`observed accepted rate 30s before first step_up: ` +
    `${rateInWindow(acceptedAt, moves[0] - 30_000, moves[0])}/s`);
  const lastMove = moves[moves.length - 1] ?? 0;
  output(`observed accepted rate 30s after last step_up: ` +
    `${rateInWindow(acceptedAt, lastMove, lastMove + 30_000)}/s`);
}

function rateInWindow(times: number[], start: number, end: number): string {
  const total = times.filter((time) => time >= start && time < end).length;
  return (total / 30).toFixed(2);
}

async function readStorm(path: string): Promise<StormRecord[]> {
  try {
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line) as StormRecord);
  } catch {
    return [];
  }
}

async function sleepWithSignal(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const abort = () => finish(false);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
