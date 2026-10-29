import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileConfig } from '../config.ts';
import { runReplay, type ReplayResult } from '../sim/driver.ts';
import { loadResponseModel } from '../sim/response-model.ts';
import type { ReplayFile } from '../sim/replay.ts';
import type { ReportProposal } from './schema.ts';

export type ScoreMetrics = {
  stepsTaken: number;
  peakStep: number;
  reversalsWithinDwell: number;
  timeToRestoreSeconds: number | null;
  noticesSent: number;
  finalSettingsEqualBaseline: boolean;
  peakPace: number;
};

export type ScoreCriterion = {
  name: string;
  passed: boolean;
};

export type ReportScore = {
  current: ScoreMetrics;
  proposed: ScoreMetrics;
  criteria: ScoreCriterion[];
  passed: boolean;
  paceSource: 'modeled' | 'recorded';
};

export async function scoreScenario(
  replay: ReplayFile,
  currentProfile: ProfileConfig,
  proposal: ReportProposal,
  tailSeconds = 90,
): Promise<ReportScore> {
  const paceSource = replay.header.synthetic ? 'modeled' : 'recorded';
  const model = replay.header.synthetic ? await loadResponseModel() : null;
  const proposedProfile = {
    ...currentProfile,
    setpoint_msgs_per_s: proposal.setpoint,
    dwell_s: proposal.dwell_s,
    release_hold_s: proposal.release_hold_s,
  };
  const currentResult = await runIsolated(replay, currentProfile, tailSeconds, model);
  const proposedResult = await runIsolated(replay, proposedProfile, tailSeconds, model);
  const current = scoreMetrics(currentResult, currentProfile.dwell_s);
  const proposed = scoreMetrics(proposedResult, proposal.dwell_s);
  const criteria = compareScores(current, proposed);
  return {
    current,
    proposed,
    criteria,
    passed: criteria.every((criterion) => criterion.passed),
    paceSource,
  };
}

async function runIsolated(
  replay: ReplayFile,
  profile: ProfileConfig,
  tailSeconds: number,
  model: Awaited<ReturnType<typeof loadResponseModel>> | null,
): Promise<ReplayResult> {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-report-score-'));
  try {
    return await runReplay(replay, profile, directory, tailSeconds, undefined, model);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function scoreMetrics(
  result: ReplayResult,
  dwellSeconds: number,
): ScoreMetrics {
  const decisions = result.decisions;
  const peakStep = decisions.reduce((peak, item) => Math.max(peak, item.step), 0);
  const restore = lastRestoreTime(result);
  return {
    stepsTaken: decisions.filter((item) => item.action === 'step_up').length,
    peakStep,
    reversalsWithinDwell: reversalCount(decisions, dwellSeconds),
    timeToRestoreSeconds: restore,
    noticesSent: result.replies.length,
    finalSettingsEqualBaseline: equalSettings(result.finalSettings, result.baseline),
    peakPace: decisions.reduce((peak, item) => Math.max(peak, item.pace), 0),
  };
}

function lastRestoreTime(result: ReplayResult): number | null {
  const lastUp = result.decisions.filter((item) => item.action === 'step_up').at(-1);
  if (!lastUp) return 0;
  const restore = result.decisions.find((item) =>
    item.action === 'restore' && item.offset_ms >= lastUp.offset_ms);
  return restore ? (restore.offset_ms - lastUp.offset_ms) / 1000 : null;
}

function reversalCount(
  decisions: ReplayResult['decisions'],
  dwellSeconds: number,
): number {
  const moves = decisions.filter((item) =>
    item.action === 'step_up' || item.action === 'step_down' || item.action === 'restore');
  let count = 0;
  for (let index = 1; index < moves.length; index += 1) {
    const previous = moves[index - 1];
    const current = moves[index];
    if (!previous || !current) continue;
    const reversed = previous.action === 'step_up' && current.action !== 'step_up';
    const previousDown = previous.action !== 'step_up';
    if ((reversed || (previousDown && current.action === 'step_up')) &&
      current.offset_ms - previous.offset_ms < dwellSeconds * 1000) count += 1;
  }
  return count;
}

export function compareScores(
  current: ScoreMetrics,
  proposed: ScoreMetrics,
): ScoreCriterion[] {
  const restoreLimit = current.timeToRestoreSeconds === null
    ? Number.NEGATIVE_INFINITY
    : current.timeToRestoreSeconds * 1.2;
  return [
    {
      name: 'final settings equal baseline',
      passed: proposed.finalSettingsEqualBaseline,
    },
    {
      name: 'no step reversal within proposed dwell',
      passed: proposed.reversalsWithinDwell === 0,
    },
    {
      name: 'peak step not higher than current run',
      passed: proposed.peakStep <= current.peakStep,
    },
    {
      name: 'notices sent no more than current plus two',
      passed: proposed.noticesSent <= current.noticesSent + 2,
    },
    {
      name: 'time to restore no more than 20% longer',
      passed: proposed.timeToRestoreSeconds !== null &&
        proposed.timeToRestoreSeconds <= restoreLimit,
    },
  ];
}

function equalSettings(
  current: ReplayResult['finalSettings'],
  baseline: ReplayResult['baseline'],
): boolean {
  return current.slow_mode === baseline.slow_mode &&
    current.follower_mode === baseline.follower_mode &&
    current.emote_mode === baseline.emote_mode &&
    current.subscriber_mode === baseline.subscriber_mode &&
    current.unique_chat_mode === baseline.unique_chat_mode &&
    (!baseline.slow_mode || current.slow_mode_wait_time === baseline.slow_mode_wait_time) &&
    (!baseline.follower_mode ||
      current.follower_mode_duration === baseline.follower_mode_duration);
}
