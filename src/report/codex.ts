import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileConfig } from '../config.ts';
import { REPORT_SCHEMA, parseReportCard, type ReportCard } from './schema.ts';

export type CodexClock = {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<boolean>;
};

export type CodexProcessOptions = {
  cwd: string;
  env: Record<string, string>;
  onStdout(data: string): void;
};

export type CodexProcessHandle = {
  completion: Promise<number>;
  kill(): void;
};

export type CodexProcessRunner = (
  command: string,
  args: string[],
  options: CodexProcessOptions,
) => CodexProcessHandle;

export type GenerateReportOptions = {
  stateDirectory: string;
  profileName: string;
  profile: ProfileConfig;
  runner?: CodexProcessRunner;
  clock?: CodexClock;
  timeoutMs?: number;
  output?: (line: string) => void;
  isTTY?: boolean;
};

export type GeneratedReport = {
  card: ReportCard;
  codexThreadId: string | null;
  stormHash: string;
};

const PROMPT = [
  'Read storm.log.jsonl and context.json in the current directory.',
  'Explain what happened in plain words. List controller steps with their',
  'triggering readings. Propose setpoint, dwell_s, and release_hold_s.',
  'Name one risk. Answer only with the JSON object matching the schema.',
].join(' ');

const SYSTEM_CLOCK: CodexClock = {
  now: Date.now,
  sleep: sleepWithSignal,
};

export function buildCodexArguments(scratch: string): string[] {
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '-C',
    scratch,
    '--output-schema',
    join(scratch, 'report.schema.json'),
    '-o',
    join(scratch, 'last-message.json'),
    PROMPT,
  ];
}

export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = ['HOME', 'CODEX_HOME', 'PATH', 'TMPDIR', 'TEMP', 'LANG'];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export async function generateReport(
  options: GenerateReportOptions,
): Promise<GeneratedReport> {
  const scratch = await mkdtemp(join(tmpdir(), 'undertow-report-'));
  const logPath = join(options.stateDirectory, 'storm.log.jsonl');
  const schemaPath = join(scratch, 'report.schema.json');
  const outputPath = join(scratch, 'last-message.json');
  try {
    await copyFile(logPath, join(scratch, 'storm.log.jsonl'));
    const stormHash = createHash('sha256')
      .update(await readFile(join(scratch, 'storm.log.jsonl')))
      .digest('hex');
    await writeFile(join(scratch, 'context.json'), JSON.stringify({
      profile_name: options.profileName,
      ...options.profile,
    }, null, 2), { mode: 0o600 });
    await writeFile(schemaPath, JSON.stringify(REPORT_SCHEMA, null, 2), { mode: 0o600 });
    const thread = await runProcess(
      options.runner ?? systemProcessRunner,
      buildCodexArguments(scratch),
      scratch,
      options,
    );
    const card = parseReportCard(JSON.parse(await readFile(outputPath, 'utf8')) as unknown);
    return { card, codexThreadId: thread, stormHash };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runProcess(
  runner: CodexProcessRunner,
  args: string[],
  scratch: string,
  options: GenerateReportOptions,
): Promise<string | null> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const tty = options.isTTY ?? Boolean(process.stdout.isTTY);
  const output = options.output ?? ((line: string) => {
    if (tty) process.stdout.write(line);
    else console.log(line);
  });
  const startedAt = clock.now();
  const threadId = { value: null as string | null };
  let stdoutBuffer = '';
  let showedWaiting = false;
  const processHandle = runner('codex', args, {
    cwd: scratch,
    env: codexEnvironment(),
    onStdout(data) {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) captureThreadId(line, threadId);
    },
  });
  const completion = processHandle.completion.then((code) => ({ code }));
  let nextNoticeMs = 5000;
  try {
    while (true) {
      const elapsed = clock.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        throw timeoutError(timeoutMs);
      }
      const waitMs = Math.min(remaining, nextNoticeMs - elapsed);
      const waitAbort = new AbortController();
      const race = await Promise.race([
        completion,
        clock.sleep(Math.max(1, waitMs), waitAbort.signal).then(() => null),
      ]);
      if (race) {
        waitAbort.abort();
        if (tty && showedWaiting) {
          output('\n');
          showedWaiting = false;
        }
        if (stdoutBuffer) captureThreadId(stdoutBuffer, threadId);
        if (race.code !== 0) throw new Error(`Codex exited with status ${race.code}`);
        return threadId.value;
      }
      const waited = Math.min(timeoutMs, clock.now() - startedAt);
      outputWaiting(output, tty, waited, timeoutMs);
      showedWaiting = true;
      nextNoticeMs += 5000;
      if (waited >= timeoutMs) {
        throw timeoutError(timeoutMs);
      }
    }
  } catch (error) {
    processHandle.kill();
    if (tty && showedWaiting) output('\n');
    throw error;
  }
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Codex report timed out after ${timeoutMs / 1000} seconds`);
}

function captureThreadId(
  line: string,
  result: { value: string | null },
): void {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.thread_id === 'string') result.value = value.thread_id;
    if (typeof value.payload === 'object' && value.payload !== null) {
      const payload = value.payload as Record<string, unknown>;
      if (typeof payload.thread_id === 'string') result.value = payload.thread_id;
    }
    if (typeof value.thread === 'object' && value.thread !== null) {
      const thread = value.thread as Record<string, unknown>;
      if (typeof thread.id === 'string') result.value = thread.id;
    }
  } catch {
    return;
  }
}

function outputWaiting(
  output: (line: string) => void,
  tty: boolean,
  elapsedMs: number,
  timeoutMs: number,
): void {
  const line = `waiting for codex... ${Math.floor(elapsedMs / 1000)} s of ` +
    `${Math.floor(timeoutMs / 1000)} s`;
  output(tty ? `\r${line}` : line);
}

function systemProcessRunner(
  command: string,
  args: string[],
  options: CodexProcessOptions,
): CodexProcessHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => options.onStdout(chunk));
  const completion = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  return {
    completion,
    kill: () => { child.kill('SIGKILL'); },
  };
}

async function sleepWithSignal(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const timer = setTimeout(() => finish(true), milliseconds);
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) finish(false);
  });
}
