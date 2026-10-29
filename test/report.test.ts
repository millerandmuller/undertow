import assert from 'node:assert/strict';
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { buildCodexArguments, codexEnvironment, generateReport } from '../src/report/codex.ts';
import {
  proposalRejection,
  readSavedReport,
  readStormHash,
  reportCommand,
  type SavedReport,
} from '../src/report/command.ts';
import { compareScores, scoreScenario, type ReportScore } from '../src/report/score.ts';
import { REPORT_SCHEMA, parseReportCard, type ReportCard } from '../src/report/schema.ts';
import type { CodexProcessRunner } from '../src/report/codex.ts';
import type { ScoreMetrics } from '../src/report/score.ts';
import { atomicJson } from '../src/util/files.ts';
import { loadReplay } from '../src/sim/replay.ts';

const card: ReportCard = {
  cause: 'A short burst exceeded the current threshold.',
  steps: [{
    t: '25s',
    action: 'step_up',
    reading: 'pace remained above 2 msgs/s',
  }],
  proposed: { setpoint: 1.5, dwell_s: 20, release_hold_s: 40 },
  risk: 'A longer dwell may leave chat settings elevated longer.',
};

test('report schema rejects invalid shape and additional fields', () => {
  assert.deepEqual(parseReportCard(card), card);
  assert.throws(() => parseReportCard({ ...card, extra: true }), /only/);
  assert.throws(() => parseReportCard({
    ...card,
    steps: [{ ...card.steps[0], extra: true }],
  }), /strings only/);
  assert.throws(() => parseReportCard({
    ...card,
    proposed: { ...card.proposed, extra: 1 },
  }), /invalid fields/);
  assert.equal(REPORT_SCHEMA.additionalProperties, false);
  assert.equal(REPORT_SCHEMA.properties.steps.items.additionalProperties, false);
  assert.equal(REPORT_SCHEMA.properties.proposed.additionalProperties, false);
});

test('proposal bounds reject each invalid threshold', async () => {
  const profile = await loadConfig('loadtest');
  for (const proposal of [
    { ...card, proposed: { ...card.proposed, setpoint: 0.5 } },
    { ...card, proposed: { ...card.proposed, setpoint: 4.1 } },
    { ...card, proposed: { ...card.proposed, dwell_s: 4 } },
    { ...card, proposed: { ...card.proposed, dwell_s: 121 } },
    { ...card, proposed: { ...card.proposed, release_hold_s: 9 } },
    { ...card, proposed: { ...card.proposed, release_hold_s: 301 } },
  ]) {
    assert.ok(proposalRejection(proposal, profile));
  }
  assert.equal(proposalRejection(card, profile), null);
});

test('Codex arguments use an isolated read-only scratch root', () => {
  const scratch = '/tmp/undertow-report-check';
  const args = buildCodexArguments(scratch);
  assert.deepEqual(args, [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '--json', '-C', scratch, '--output-schema',
    `${scratch}/report.schema.json`, '-o', `${scratch}/last-message.json`,
    'Read storm.log.jsonl and context.json in the current directory. Explain ' +
    'what happened in plain words. List controller steps with their triggering ' +
    'readings. Propose setpoint, dwell_s, and release_hold_s. Name one risk. ' +
    'Answer only with the JSON object matching the schema.',
  ]);
  assert.equal(args.includes('--full-auto'), false);
  assert.deepEqual(codexEnvironment({
    PATH: '/bin',
    TWITCH_CLIENT_SECRET: 'hidden',
    OPENAI_API_KEY: 'hidden',
  }), { PATH: '/bin' });
});

test('Codex scratch contains only supplied files and is removed after success', async () => {
  const directory = await temporaryDirectory();
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory);
  const storm = join(stateDirectory, 'storm.log.jsonl');
  await writeFile(storm, '{"action":"step_up"}\n');
  const profile = await loadConfig('loadtest');
  let scratch = '';
  let command = '';
  let args: string[] = [];
  let copiedContext: Record<string, unknown> = {};
  const runner: CodexProcessRunner = (_command, passed, options) => {
    command = _command;
    args = passed;
    scratch = options.cwd;
    return fakeProcess(async () => {
      const files = (await readdir(options.cwd)).sort();
      assert.deepEqual(files, [
        'context.json', 'report.schema.json', 'storm.log.jsonl',
      ]);
      copiedContext = JSON.parse(await readFile(
        join(options.cwd, 'context.json'),
        'utf8',
      )) as Record<string, unknown>;
      assert.equal(await readFile(join(options.cwd, 'storm.log.jsonl'), 'utf8'),
        '{"action":"step_up"}\n');
      assert.ok(args.every((item) => !item.includes(process.cwd())));
      assert.ok(options.cwd.startsWith(tmpdir()));
      assert.equal(options.env.TWITCH_CLIENT_SECRET, undefined);
      options.onStdout('{"type":"thread.started","thread_id":"thread-7"}\n');
      await writeFile(join(options.cwd, 'last-message.json'), JSON.stringify(card));
    });
  };
  try {
    const generated = await generateReport({
      stateDirectory,
      profileName: 'loadtest',
      profile,
      runner,
    });
    assert.equal(command, 'codex');
    assert.equal(args[0], 'exec');
    assert.equal(args[2], 'read-only');
    assert.equal(generated.codexThreadId, 'thread-7');
    assert.match(generated.stormHash, /^[a-f0-9]{64}$/);
    assert.equal(copiedContext.profile_name, 'loadtest');
    await assert.rejects(access(scratch));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex timeout reports elapsed time, kills child, and removes scratch', async () => {
  const directory = await stateDirectory();
  const profile = await loadConfig('loadtest');
  let now = 0;
  let scratch = '';
  let killed = 0;
  const waits: string[] = [];
  await assert.rejects(generateReport({
    stateDirectory: directory,
    profileName: 'loadtest',
    profile,
    timeoutMs: 10_000,
    clock: {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        return true;
      },
    },
    isTTY: false,
    output: (line) => waits.push(line),
    runner: (_command, _args, options) => {
      scratch = options.cwd;
      return {
        completion: new Promise<number>(() => undefined),
        kill: () => { killed += 1; },
      };
    },
  }), /timed out after 10 seconds/);
  assert.deepEqual(waits, [
    'waiting for codex... 5 s of 10 s',
    'waiting for codex... 10 s of 10 s',
  ]);
  assert.equal(killed, 1);
  await assert.rejects(access(scratch));
  await rm(directory, { recursive: true, force: true });
});

test('Codex process error removes scratch directory', async () => {
  const directory = await stateDirectory();
  const profile = await loadConfig('loadtest');
  let scratch = '';
  await assert.rejects(generateReport({
    stateDirectory: directory,
    profileName: 'loadtest',
    profile,
    runner: (_command, _args, options) => {
      scratch = options.cwd;
      return {
        completion: Promise.resolve(9),
        kill: () => undefined,
      };
    },
  }), /status 9/);
  await assert.rejects(access(scratch));
  await rm(directory, { recursive: true, force: true });
});

test('score criteria independently reject each failed condition', () => {
  const current: ScoreMetrics = {
    stepsTaken: 3,
    peakStep: 3,
    reversalsWithinDwell: 0,
    timeToRestoreSeconds: 10,
    noticesSent: 2,
    finalSettingsEqualBaseline: true,
    peakPace: 3.4,
  };
  const failures: ScoreMetrics[] = [
    { ...current, finalSettingsEqualBaseline: false },
    { ...current, reversalsWithinDwell: 1 },
    { ...current, peakStep: 4 },
    { ...current, noticesSent: 5 },
    { ...current, timeToRestoreSeconds: 13 },
  ];
  failures.forEach((proposal, index) => {
    const criteria = compareScores(current, proposal);
    assert.equal(criteria[index]?.passed, false);
    assert.equal(criteria.filter((criterion) => !criterion.passed).length, 1);
  });
});

test('report simulator scoring is deterministic across three runs', async () => {
  const replay = await loadReplay('replays/gift-wave.jsonl');
  const profile = await loadConfig('loadtest');
  const scores = [];
  for (let index = 0; index < 3; index += 1) {
    scores.push(await scoreScenario(replay, profile, card.proposed));
  }
  assert.deepEqual(scores[0], scores[1]);
  assert.deepEqual(scores[1], scores[2]);
});

test('saved report can apply only its three values after PASS and matching hash', async () => {
  const fixture = await commandFixture();
  const before = await readFile(fixture.configPath, 'utf8');
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  await saveReport(fixture.reportPath, { ...card, proposed: {
    setpoint: 1.5,
    dwell_s: 20,
    release_hold_s: 40,
  } }, hash);
  const output: string[] = [];
  try {
    await reportCommand([
      '--saved', '--accept', '--profile', 'loadtest',
      '--scenario', 'replays/gift-wave.jsonl',
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
    });
    const after = await readFile(fixture.configPath, 'utf8');
    const parsedBefore = JSON.parse(before) as Record<string, Record<string, unknown>>;
    const parsedAfter = JSON.parse(after) as Record<string, Record<string, unknown>>;
    assert.deepEqual(parsedAfter.real, parsedBefore.real);
    assert.equal(parsedAfter.loadtest?.setpoint_msgs_per_s, 1.5);
    assert.equal(parsedAfter.loadtest?.dwell_s, 20);
    assert.equal(parsedAfter.loadtest?.release_hold_s, 40);
    assert.ok(output.includes('Applied.'));
    assert.equal((await stat(fixture.reportPath)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('successful Codex report is saved atomically with its thread id', async () => {
  const fixture = await commandFixture();
  const output: string[] = [];
  const runner: CodexProcessRunner = (_command, _args, options) => {
    options.onStdout('{"type":"thread.started","thread_id":"thread-9"}\n');
    return {
      completion: writeFile(
        join(options.cwd, 'last-message.json'),
        JSON.stringify(card),
      ).then(() => 0),
      kill: () => undefined,
    };
  };
  try {
    await reportCommand([
      '--profile', 'loadtest', '--scenario', 'replays/gift-wave.jsonl',
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: runner,
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
      now: () => new Date('2026-10-28T12:00:00.000Z'),
    });
    const saved = await readSavedReport(fixture.reportPath);
    assert.equal(saved?.codex_thread_id, 'thread-9');
    assert.equal(saved?.storm_hash, await readStormHash(fixture.stormPath, true));
    assert.equal(saved?.timestamp, '2026-10-28T12:00:00.000Z');
    assert.equal((await stat(fixture.reportPath)).mode & 0o777, 0o600);
    assert.ok(!output.join('\n').includes('thread-9'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('report config stays byte-identical without accept and after refusals', async () => {
  const fixture = await commandFixture();
  const original = await readFile(fixture.configPath, 'utf8');
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  const baseArgs = ['--saved', '--profile', 'loadtest', '--scenario',
    'replays/gift-wave.jsonl'];
  try {
    await assert.rejects(reportCommand([...baseArgs, '--accept'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      output: () => undefined,
    }), /No saved report exists/);
    assert.equal(await readFile(fixture.configPath, 'utf8'), original);
    await saveReport(fixture.reportPath, card, hash);
    await reportCommand(baseArgs, {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => passingScore(),
      output: () => undefined,
    });
    assert.equal(await readFile(fixture.configPath, 'utf8'), original);
    await assert.rejects(reportCommand([...baseArgs, '--accept'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => ({ ...passingScore(), passed: false }),
      output: () => undefined,
    }), /failed scoring/);
    assert.equal(await readFile(fixture.configPath, 'utf8'), original);
    await writeFile(fixture.stormPath, decisionLine('modeled', 'changed'));
    await assert.rejects(reportCommand([...baseArgs, '--accept'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => passingScore(),
      output: () => undefined,
    }), /Storm log changed/);
    assert.equal(await readFile(fixture.configPath, 'utf8'), original);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejected out-of-bounds report cannot be scored or accepted', async () => {
  const fixture = await commandFixture();
  const original = await readFile(fixture.configPath, 'utf8');
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  const invalid = {
    ...card,
    proposed: { ...card.proposed, setpoint: 5 },
  };
  await saveReport(fixture.reportPath, invalid, hash);
  const output: string[] = [];
  let scored = false;
  try {
    await assert.rejects(reportCommand([
      '--saved', '--accept', '--profile', 'loadtest',
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => {
        scored = true;
        return passingScore();
      },
      output: (line) => output.push(line),
    }), /Rejected proposals cannot be accepted/);
    assert.ok(output.some((line) => line.startsWith('REJECTED:')));
    assert.equal(scored, false);
    assert.equal(await readFile(fixture.configPath, 'utf8'), original);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('report fallback uses saved card and fails clearly without one', async () => {
  const fixture = await commandFixture();
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  await saveReport(fixture.reportPath, card, hash);
  const output: string[] = [];
  let now = 0;
  const neverRunner: CodexProcessRunner = () => ({
    completion: new Promise<number>(() => undefined),
    kill: () => undefined,
  });
  const failedRunner: CodexProcessRunner = () => ({
    completion: Promise.resolve(4),
    kill: () => undefined,
  });
  try {
    await reportCommand(['--profile', 'loadtest', '--scenario',
      'replays/gift-wave.jsonl'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: neverRunner,
      clock: {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
          return true;
        },
      },
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
    });
    assert.ok(output.some((line) => line.startsWith('saved report (')));
    assert.ok(output.includes('Codex failed: Codex report timed out after 90 seconds'));
    assert.ok(output.includes('waiting for codex... 5 s of 90 s'));
    assert.ok(output.some((line) => line.includes('peak pace 2.0 msgs/s (modeled)')));
    const emptyDirectory = join(fixture.directory, 'empty-state');
    await mkdir(emptyDirectory);
    await writeFile(join(emptyDirectory, 'storm.log.jsonl'), decisionLine());
    const failedOutput: string[] = [];
    await assert.rejects(reportCommand(['--profile', 'loadtest'], {
      stateDirectory: emptyDirectory,
      configPath: fixture.configPath,
      processRunner: failedRunner,
      output: (line) => failedOutput.push(line),
    }), /Codex report unavailable and no saved report exists/);
    assert.ok(failedOutput.includes('Codex failed: Codex exited with status 4'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('saved reports cannot be accepted into a different profile', async () => {
  const fixture = await commandFixture();
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  await saveReport(fixture.reportPath, {
    ...card,
    proposed: { setpoint: 6, dwell_s: 20, release_hold_s: 40 },
  }, hash);
  const before = await readFile(fixture.configPath, 'utf8');
  try {
    await assert.rejects(reportCommand([
      '--saved', '--accept', '--profile', 'real', '--scenario',
      'replays/gift-wave.jsonl',
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => passingScore(),
      output: () => undefined,
    }), /profile does not match/);
    assert.equal(await readFile(fixture.configPath, 'utf8'), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('recorded report rates stay labeled recorded', async () => {
  const fixture = await commandFixture();
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  await saveReport(fixture.reportPath, card, hash);
  const recordedPath = join(fixture.directory, 'recorded.jsonl');
  const source = await readFile('replays/gift-wave.jsonl', 'utf8');
  const rows = source.trim().split('\n');
  const header = JSON.parse(rows[0] ?? '{}') as Record<string, unknown>;
  header.synthetic = false;
  rows[0] = JSON.stringify(header);
  await writeFile(recordedPath, `${rows.join('\n')}\n`);
  const output: string[] = [];
  try {
    await reportCommand([
      '--saved', '--profile', 'loadtest', '--scenario', recordedPath,
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      scorer: async () => ({ ...passingScore(), paceSource: 'recorded' }),
      output: (line) => output.push(line),
    });
    const rateLines = output.filter((line) => line.includes('peak pace'));
    assert.ok(rateLines.length > 0);
    assert.ok(rateLines.every((line) => line.includes('(recorded)')));
    assert.ok(rateLines.every((line) => !line.includes('(modeled)')));
    assert.ok(output.includes('VERDICT: PASS (recorded scores)'));
    assert.ok(output.includes('labels: unknown'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('modeled storm log never prints recorded labels', async () => {
  const fixture = await commandFixture();
  await writeFile(fixture.stormPath, decisionLine('modeled'));
  const output: string[] = [];
  try {
    await reportCommand(['--profile', 'loadtest'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: reportRunner(card),
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
    });
    assert.ok(output.includes('storm readings: modeled'));
    assert.equal(output.join('\n').includes('recorded'), false);
    assert.ok(output.some((line) => line.includes('configured, modeled')));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('recorded storm log never prints modeled labels', async () => {
  const fixture = await commandFixture();
  const scenario = join(fixture.directory, 'recorded-scenario.jsonl');
  await makeRecordedScenario(scenario);
  const output: string[] = [];
  try {
    await reportCommand(['--profile', 'loadtest', '--scenario', scenario], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: reportRunner(card),
      scorer: async () => ({ ...passingScore(), paceSource: 'recorded' }),
      output: (line) => output.push(line),
    });
    assert.ok(output.includes('storm readings: recorded'));
    assert.equal(output.join('\n').includes('modeled'), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('report rejects a pace label missing from a storm log line', async () => {
  const fixture = await commandFixture();
  await writeFile(fixture.stormPath, '{"action":"step_up"}\n');
  try {
    await assert.rejects(reportCommand(['--profile', 'loadtest'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: reportRunner(card),
      output: () => undefined,
    }), /line 1.*missing or unknown pace_source/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('mixed report labels follow each step log line and ignore Codex labels', async () => {
  const fixture = await commandFixture();
  await writeFile(fixture.stormPath,
    `${decisionLine('recorded', 'step_up')}${decisionLine('modeled', 'step_down')}`);
  const output: string[] = [];
  const mixedCard = {
    ...card,
    steps: [
      { t: 'up', action: 'step_up', reading: 'pace 3/s (modeled)' },
      { t: 'down', action: 'step_down', reading: 'pace 1/s (recorded)' },
    ],
  };
  try {
    await reportCommand(['--profile', 'loadtest'], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: reportRunner(mixedCard),
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
    });
    assert.ok(output.includes('storm readings: mixed'));
    assert.ok(output.includes('  up | step_up | pace 3/s (recorded)'));
    assert.ok(output.includes('  down | step_down | pace 1/s (modeled)'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('report accept applies a passing Codex proposal only to the scratch config', async () => {
  const fixture = await commandFixture();
  const repositoryConfig = await readFile('undertow.config.json', 'utf8');
  const original = await readFile(fixture.configPath, 'utf8');
  const output: string[] = [];
  const proposal = {
    ...card,
    proposed: { setpoint: 1.2, dwell_s: 20, release_hold_s: 40 },
  };
  try {
    await reportCommand([
      '--accept', '--profile', 'loadtest', '--scenario',
      'replays/gift-wave.jsonl',
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: reportRunner(proposal),
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
    });
    const after = await readFile(fixture.configPath, 'utf8');
    const beforeConfig = JSON.parse(original) as Record<string, Record<string, unknown>>;
    const afterConfig = JSON.parse(after) as Record<string, Record<string, unknown>>;
    assert.deepEqual(afterConfig.real, beforeConfig.real);
    assert.deepEqual(afterConfig.loadtest, {
      ...beforeConfig.loadtest,
      setpoint_msgs_per_s: 1.2,
      dwell_s: 20,
      release_hold_s: 40,
    });
    assert.ok(output.includes('  setpoint_msgs_per_s: 1.5 -> 1.2'));
    assert.ok(output.includes('  dwell_s: 15 -> 20'));
    assert.ok(output.includes('  release_hold_s: 30 -> 40'));
    assert.equal(await readFile('undertow.config.json', 'utf8'), repositoryConfig);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('invalid Codex output falls back to the saved report', async () => {
  const fixture = await commandFixture();
  const hash = await readStormHash(fixture.stormPath, true);
  assert.ok(hash);
  await saveReport(fixture.reportPath, card, hash);
  const output: string[] = [];
  const invalidRunner: CodexProcessRunner = (_command, _args, options) => ({
    completion: writeFile(
      join(options.cwd, 'last-message.json'),
      JSON.stringify({ cause: 'bad shape' }),
    ).then(() => 0),
    kill: () => undefined,
  });
  try {
    await reportCommand([
      '--profile', 'loadtest', '--scenario', 'replays/gift-wave.jsonl',
    ], {
      stateDirectory: fixture.stateDirectory,
      configPath: fixture.configPath,
      processRunner: invalidRunner,
      scorer: async () => passingScore(),
      output: (line) => output.push(line),
    });
    assert.ok(output.some((line) => line.startsWith('saved report (')));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function fakeProcess(writeOutput: () => Promise<void>) {
  const completion = writeOutput().then(() => 0);
  return { completion, kill: () => undefined };
}

async function stateDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, 'state'));
  await writeFile(join(directory, 'state', 'storm.log.jsonl'), decisionLine());
  return join(directory, 'state');
}

async function commandFixture(): Promise<{
  directory: string;
  stateDirectory: string;
  configPath: string;
  stormPath: string;
  reportPath: string;
}> {
  const directory = await temporaryDirectory();
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory);
  await writeFile(join(stateDirectory, 'storm.log.jsonl'), decisionLine());
  const configPath = join(directory, 'undertow.config.json');
  await copyFile('undertow.config.json', configPath);
  return {
    directory,
    stateDirectory,
    configPath,
    stormPath: join(stateDirectory, 'storm.log.jsonl'),
    reportPath: join(stateDirectory, 'report.last.json'),
  };
}

function decisionLine(
  paceSource: 'recorded' | 'modeled' = 'recorded',
  reason = 'fixture',
): string {
  return `${JSON.stringify({
    t: '2026-10-28T12:00:00.000Z',
    pace: 2,
    pace_source: paceSource,
    action: reason,
    reason,
  })}\n`;
}

function reportRunner(reportCard: ReportCard): CodexProcessRunner {
  return (_command, _args, options) => ({
    completion: writeFile(
      join(options.cwd, 'last-message.json'),
      JSON.stringify(reportCard),
    ).then(() => 0),
    kill: () => undefined,
  });
}

async function makeRecordedScenario(path: string): Promise<void> {
  const source = await readFile('replays/gift-wave.jsonl', 'utf8');
  const rows = source.trim().split('\n');
  const header = JSON.parse(rows[0] ?? '{}') as Record<string, unknown>;
  header.synthetic = false;
  rows[0] = JSON.stringify(header);
  await writeFile(path, `${rows.join('\n')}\n`);
}

async function saveReport(path: string, reportCard: ReportCard, hash: string) {
  const saved: SavedReport = {
    card: reportCard,
    timestamp: '2026-10-28T12:00:00.000Z',
    storm_hash: hash,
    profile: 'loadtest',
    codex_thread_id: null,
  };
  await atomicJson(path, saved);
}

function passingScore(): ReportScore {
  const metrics: ScoreMetrics = {
    stepsTaken: 2,
    peakStep: 2,
    reversalsWithinDwell: 0,
    timeToRestoreSeconds: 20,
    noticesSent: 3,
    finalSettingsEqualBaseline: true,
    peakPace: 2,
  };
  return {
    current: metrics,
    proposed: metrics,
    criteria: [
      'final settings equal baseline',
      'no step reversal within proposed dwell',
      'peak step not higher than current run',
      'notices sent no more than current plus two',
      'time to restore no more than 20% longer',
    ].map((name) => ({ name, passed: true })),
    passed: true,
    paceSource: 'modeled',
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'undertow-report-test-'));
}
