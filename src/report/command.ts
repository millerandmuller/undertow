import { readLabeledStorm } from './storm.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ProfileConfig } from '../config.ts';
import { atomicJson, readJson } from '../util/files.ts';
import { loadReplay } from '../sim/replay.ts';
import { updateConfigAtomically } from './config-update.ts';
import {
  generateReport,
  type CodexClock,
  type CodexProcessRunner,
} from './codex.ts';
import { scoreScenario, type ReportScore } from './score.ts';
import { parseReportCard, type ReportCard } from './schema.ts';

export type SavedReport = {
  card: ReportCard;
  timestamp: string;
  storm_hash: string;
  profile: string;
  codex_thread_id: string | null;
  pace_label?: PaceLabel;
  step_labels?: PaceLabel[];
};

type PaceLabel = 'recorded' | 'modeled' | 'mixed' | 'unknown';

export type ReportCommandDependencies = {
  stateDirectory?: string;
  configPath?: string | URL;
  processRunner?: CodexProcessRunner;
  clock?: CodexClock;
  output?: (line: string) => void;
  now?: () => Date;
  scorer?: typeof scoreScenario;
};

export function proposalRejection(
  card: ReportCard,
  profile: ProfileConfig,
): string | null {
  const low = Math.max(0.5, profile.setpoint_msgs_per_s / 2);
  const high = profile.setpoint_msgs_per_s * 2;
  if (card.proposed.setpoint < low || card.proposed.setpoint > high) {
    return `setpoint must be between ${low} and ${high}`;
  }
  if (card.proposed.dwell_s < 5 || card.proposed.dwell_s > 120) {
    return 'dwell_s must be between 5 and 120';
  }
  if (card.proposed.release_hold_s < 10 || card.proposed.release_hold_s > 300) {
    return 'release_hold_s must be between 10 and 300';
  }
  return null;
}

export async function reportCommand(
  args: string[],
  dependencies: ReportCommandDependencies = {},
): Promise<void> {
  const output = dependencies.output ?? console.log;
  const stateDirectory = dependencies.stateDirectory ??
    process.env.UNDERTOW_STATE_DIR ?? '.undertow';
  const configPath = typeof dependencies.configPath === 'string'
    ? dependencies.configPath
    : dependencies.configPath
    ? fileURLToPath(dependencies.configPath)
    : process.env.UNDERTOW_CONFIG_PATH ??
      fileURLToPath(new URL('../../undertow.config.json', import.meta.url));
  const savedPath = join(stateDirectory, 'report.last.json');
  const stormPath = join(stateDirectory, 'storm.log.jsonl');
  const savedOnly = args.includes('--saved');
  const accept = args.includes('--accept');
  const explicitProfile = option(args, '--profile');
  let saved: SavedReport | null = null;
  if (savedOnly) saved = await readSavedReport(savedPath);
  const profileName = explicitProfile ?? (savedOnly ? saved?.profile : undefined) ??
    process.env.UNDERTOW_PROFILE ?? 'real';
  const profile = await loadConfig(profileName, configPath);
  await readStormHash(stormPath, !savedOnly, output);
  const paceLabels = savedOnly ? null : await readPaceLabels(stormPath);
  const scenario = option(args, '--scenario') ?? 'replays/gift-wave.jsonl';
  let report: SavedReport;
  let sourceLabel = 'Codex report';

  if (savedOnly) {
    if (!saved) throw new Error('No saved report exists; run undertow report after a storm');
    report = saved;
    sourceLabel = `saved report (${saved.timestamp})`;
  } else {
    const requested = await requestOrFallback({
      savedPath,
      profile,
      profileName,
      stateDirectory,
      processRunner: dependencies.processRunner,
      clock: dependencies.clock,
      now: dependencies.now,
      output,
    });
    report = requested.report;
    if (requested.usedSaved) sourceLabel = `saved report (${report.timestamp})`;
  }

  const labels = report.pace_label
    ? { overall: report.pace_label, steps: report.step_labels ?? [] }
    : paceLabels ?? { overall: 'unknown' as const, steps: [] };

  output(sourceLabel);
  output(labels.overall === 'unknown'
    ? 'labels: unknown'
    : `storm readings: ${labels.overall}`);
  printCard(report.card, profile, labels, output);
  const rejection = proposalRejection(report.card, profile);
  if (rejection) {
    output(`REJECTED: ${rejection}`);
    if (accept) throw new Error('Rejected proposals cannot be accepted');
    return;
  }

  const replay = await loadReplay(scenario);
  const score = await (dependencies.scorer ?? scoreScenario)(
    replay,
    profile,
    report.card.proposed,
  );
  printScore(score, output);
  if (!accept) {
    output('Proposal not applied. Re-run with --accept to apply it.');
    return;
  }
  if (!score.passed) throw new Error('Proposal failed scoring and cannot be accepted');
  if (report.profile !== profileName) {
    throw new Error('Saved report profile does not match the profile being accepted');
  }
  const acceptanceHash = await readStormHash(stormPath, true);
  if (!acceptanceHash || report.storm_hash !== acceptanceHash) {
    throw new Error('Storm log changed since this report; proposal cannot be accepted');
  }
  printDiff(profileName, profile, report.card, output);
  await updateConfigAtomically(configPath, profileName, report.card.proposed);
  output('Applied.');
}

async function requestOrFallback(options: {
  savedPath: string;
  profile: ProfileConfig;
  profileName: string;
  stateDirectory: string;
  processRunner?: CodexProcessRunner;
  clock?: CodexClock;
  now?: () => Date;
  output: (line: string) => void;
}): Promise<{ report: SavedReport; usedSaved: boolean }> {
  try {
    const labels = await readPaceLabels(join(
      options.stateDirectory,
      'storm.log.jsonl',
    ));
    const generated = await generateReport({
      stateDirectory: options.stateDirectory,
      profileName: options.profileName,
      profile: options.profile,
      runner: options.processRunner,
      clock: options.clock,
      output: options.output,
    });
    const saved: SavedReport = {
      card: generated.card,
      timestamp: (options.now?.() ?? new Date()).toISOString(),
      storm_hash: generated.stormHash,
      profile: options.profileName,
      codex_thread_id: generated.codexThreadId,
      pace_label: labels.overall,
      step_labels: labels.steps,
    };
    await atomicJson(options.savedPath, saved);
    return { report: saved, usedSaved: false };
  } catch (error) {
    options.output(`Codex failed: ${codexFailureReason(error)}`);
    const saved = await readSavedReport(options.savedPath);
    if (saved) return { report: saved, usedSaved: true };
    throw new Error('Codex report unavailable and no saved report exists');
  }
}

function codexFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^Codex exited with status \d+$/.test(message)) return message;
  if (/^Codex report timed out after \d+ seconds$/.test(message)) return message;
  return 'unavailable or returned invalid output';
}

export async function readSavedReport(path: string): Promise<SavedReport | null> {
  try {
    const raw = await readJson<Record<string, unknown>>(path);
    if (!isObject(raw) || ![5, 7].includes(Object.keys(raw).length) ||
      typeof raw.timestamp !== 'string' || typeof raw.storm_hash !== 'string' ||
      typeof raw.profile !== 'string' ||
      (raw.codex_thread_id !== null && typeof raw.codex_thread_id !== 'string')) {
      throw new Error('saved report has invalid fields');
    }
    return {
      card: parseReportCard(raw.card),
      timestamp: raw.timestamp,
      storm_hash: raw.storm_hash,
      profile: raw.profile,
      codex_thread_id: raw.codex_thread_id,
      ...(isPaceLabel(raw.pace_label) ? { pace_label: raw.pace_label } : {}),
      ...(Array.isArray(raw.step_labels) && raw.step_labels.every(isPaceLabel)
        ? { step_labels: raw.step_labels }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function readStormHash(
  path: string,
  required: boolean,
  output?: (line: string) => void,
): Promise<string | null> {
  try {
    const storm = await readLabeledStorm(path);
    if (storm.ignored > 0) output?.(`ignored ${storm.ignored} legacy lines without pace_source`);
    return createHash('sha256').update(storm.text).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!required) return null;
      throw new Error(`Storm log is missing at ${path}; run Undertow during a storm first`);
    }
    if (!required && error instanceof Error && error.message.startsWith('Storm log is empty')) {
      return null;
    }
    throw error;
  }
}

export async function readPaceLabels(path: string, output?: (line: string) => void): Promise<{
  overall: PaceLabel;
  steps: PaceLabel[];
}> {
  const storm = await readLabeledStorm(path);
  if (storm.ignored > 0) output?.(`ignored ${storm.ignored} legacy lines without pace_source`);
  const labels = storm.entries.map((entry) => entry.pace_source);
  const unique = [...new Set(labels)];
  const overall = unique.length === 1 ? unique[0] as PaceLabel : 'mixed';
  const stepEntries = storm.entries.filter((entry) =>
    typeof entry.action === 'string' && /step_up|step_down|restore/.test(entry.action));
  return { overall, steps: stepEntries.map((entry) => entry.pace_source) };
}

function printCard(
  card: ReportCard,
  profile: ProfileConfig,
  labels: { overall: PaceLabel; steps: PaceLabel[] },
  output: (line: string) => void,
): void {
  output(`cause: ${card.cause}`);
  output('steps:');
  for (const [index, step] of card.steps.entries()) {
    const label = labels.steps[index] ?? labels.overall;
    const reading = step.reading.replace(/\s*\((?:recorded|modeled)\)/gi, '');
    const suffix = label === 'unknown' ? '' : ` (${label})`;
    output(`  ${step.t} | ${step.action} | ${reading}${suffix}`);
  }
  const paceTag = labels.overall === 'unknown' ? 'labels unknown' : labels.overall;
  output(`setpoint: ${profile.setpoint_msgs_per_s} msgs/s (configured, ${paceTag}) -> ` +
    `${card.proposed.setpoint} msgs/s (proposed, ${paceTag})`);
  output(`dwell_s: ${profile.dwell_s} -> ${card.proposed.dwell_s}`);
  output(`release_hold_s: ${profile.release_hold_s} -> ` +
    `${card.proposed.release_hold_s}`);
  output(`risk: ${card.risk}`);
}

function printScore(score: ReportScore, output: (line: string) => void): void {
  const source = score.paceSource;
  output(`current: peak pace ${score.current.peakPace.toFixed(1)} msgs/s (${source}); ` +
    metricsText(score.current));
  output(`proposed: peak pace ${score.proposed.peakPace.toFixed(1)} msgs/s (${source}); ` +
    metricsText(score.proposed));
  for (const criterion of score.criteria) {
    output(`${criterion.passed ? 'PASS' : 'FAIL'}: ${criterion.name}`);
  }
  output(`VERDICT: ${score.passed ? 'PASS' : 'FAIL'} (${source} scores)`);
}

function metricsText(metrics: ReportScore['current']): string {
  const restore = metrics.timeToRestoreSeconds === null
    ? 'not restored'
    : `${metrics.timeToRestoreSeconds.toFixed(1)} s`;
  return `steps ${metrics.stepsTaken}, peak step ${metrics.peakStep}, ` +
    `reversals ${metrics.reversalsWithinDwell}, restore ${restore}, ` +
    `notices ${metrics.noticesSent}, baseline ` +
    `${metrics.finalSettingsEqualBaseline ? 'yes' : 'no'}`;
}

function printDiff(
  profileName: string,
  profile: ProfileConfig,
  report: ReportCard,
  output: (line: string) => void,
): void {
  output(`config diff (${profileName}):`);
  output(`  setpoint_msgs_per_s: ${profile.setpoint_msgs_per_s} -> ` +
    `${report.proposed.setpoint}`);
  output(`  dwell_s: ${profile.dwell_s} -> ${report.proposed.dwell_s}`);
  output(`  release_hold_s: ${profile.release_hold_s} -> ` +
    `${report.proposed.release_hold_s}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaceLabel(value: unknown): value is PaceLabel {
  return value === 'recorded' || value === 'modeled' || value === 'mixed' ||
    value === 'unknown';
}
