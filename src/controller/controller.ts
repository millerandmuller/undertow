import type { ProfileConfig } from '../config.ts';

export type ControllerState = {
  step: number;
  lastMoveMs: number;
  lastDirection: 'up' | 'down' | null;
  aboveSinceMs: number | null;
  aboveHistory: { atMs: number; above: boolean }[];
  belowSinceMs: number | null;
};

export type ControllerInput = {
  nowMs: number;
  rate: number;
  warnings: number | null;
  manualOverrideUntilMs: number;
};

export type ControllerAction =
  | { type: 'none' }
  | { type: 'step_up'; step: number }
  | { type: 'step_down'; step: number }
  | { type: 'restore' }
  | { type: 'yield' };

export function initialControllerState(): ControllerState {
  return {
    step: 0,
    lastMoveMs: Number.NEGATIVE_INFINITY,
    lastDirection: null,
    aboveSinceMs: null,
    aboveHistory: [],
    belowSinceMs: null,
  };
}

function idle(state: ControllerState): ControllerState {
  return {
    ...state,
    aboveSinceMs: null,
    aboveHistory: [],
    belowSinceMs: null,
  };
}

function heldLongEnough(state: ControllerState, nowMs: number, config: ProfileConfig): boolean {
  return nowMs - state.lastMoveMs >= config.dwell_s * 1000;
}

function moved(
  state: ControllerState,
  step: number,
  direction: 'up' | 'down',
  nowMs: number,
): ControllerState {
  return {
    ...state,
    step,
    lastMoveMs: nowMs,
    lastDirection: direction,
    aboveSinceMs: direction === 'up' ? state.aboveSinceMs : null,
    aboveHistory: direction === 'up' ? state.aboveHistory : [],
    belowSinceMs: direction === 'down' ? state.belowSinceMs : null,
  };
}

function reversalBlocked(
  state: ControllerState,
  direction: 'up' | 'down',
  nowMs: number,
  config: ProfileConfig,
): boolean {
  return state.lastDirection !== null && state.lastDirection !== direction &&
    !heldLongEnough(state, nowMs, config);
}

export function decide(
  state: ControllerState,
  input: ControllerInput,
  config: ProfileConfig,
): { state: ControllerState; action: ControllerAction } {
  if (input.manualOverrideUntilMs > input.nowMs) {
    return { state: idle(state), action: { type: 'yield' } };
  }

  const warningActive = input.warnings !== null &&
    input.nowMs - input.warnings <= config.warning_hold_s * 1000;
  const effectiveSetpoint = warningActive
    ? config.setpoint_msgs_per_s / config.warning_boost
    : config.setpoint_msgs_per_s;
  const releaseLevel = config.setpoint_msgs_per_s * config.release_ratio;
  const canMove = heldLongEnough(state, input.nowMs, config);

  const currentAbove = input.rate > effectiveSetpoint;
  const aboveHistory = recordAboveTick(
    state.aboveHistory,
    input.nowMs,
    currentAbove,
    config.dwell_s,
  );

  if (input.rate < releaseLevel) {
    const belowSinceMs = state.belowSinceMs ?? input.nowMs;
    const next = {
      ...state,
      aboveSinceMs: null,
      aboveHistory: [],
      belowSinceMs,
    };
    const sustained = input.nowMs - belowSinceMs >= config.release_hold_s * 1000;
    if (sustained && canMove && !reversalBlocked(state, 'down', input.nowMs, config)) {
      if (state.step > 1) {
        const step = state.step - 1;
        return {
          state: moved(state, step, 'down', input.nowMs),
          action: { type: 'step_down', step },
        };
      }
      if (state.step === 1) {
        return {
          state: moved(state, 0, 'down', input.nowMs),
          action: { type: 'restore' },
        };
      }
    }
    return { state: next, action: { type: 'none' } };
  }

  const aboveSinceMs = updateAboveStart(
    state.aboveSinceMs,
    aboveHistory,
    currentAbove,
    input.nowMs,
    config,
  );
  const next = {
    ...state,
    aboveSinceMs,
    aboveHistory,
    belowSinceMs: null,
  };
  // Step-up tolerates jitter at the edge. Step-down stays strict so it never releases early.
  const sustained = currentAbove && aboveSinceMs !== null &&
    input.nowMs - aboveSinceMs >= config.dwell_s * 1000 &&
    enoughAboveTicks(aboveHistory, config.dwell_s, config.sustain_ratio);
  if (sustained && canMove && !reversalBlocked(state, 'up', input.nowMs, config)) {
    if (state.step < config.ladder.length) {
      const step = state.step + 1;
      return {
        state: moved(next, step, 'up', input.nowMs),
        action: { type: 'step_up', step },
      };
    }
  }
  return { state: next, action: { type: 'none' } };
}

function recordAboveTick(
  history: ControllerState['aboveHistory'],
  nowMs: number,
  above: boolean,
  dwellSeconds: number,
): ControllerState['aboveHistory'] {
  const cutoff = nowMs - dwellSeconds * 1000;
  const recent = history.filter((tick) => tick.atMs > cutoff);
  const last = recent.at(-1);
  if (last?.atMs === nowMs) recent[recent.length - 1] = { atMs: nowMs, above };
  else recent.push({ atMs: nowMs, above });
  return recent.slice(-Math.ceil(dwellSeconds));
}

function updateAboveStart(
  previousStart: number | null,
  history: ControllerState['aboveHistory'],
  currentAbove: boolean,
  nowMs: number,
  config: ProfileConfig,
): number | null {
  if (config.sustain_ratio === 1) {
    return currentAbove ? previousStart ?? nowMs : null;
  }
  const start = currentAbove ? previousStart ?? nowMs : previousStart;
  if (start === null) return null;
  const count = history.filter((tick) => tick.above).length;
  const ratio = history.length === 0 ? 0 : count / history.length;
  const fullWindow = history.length >= Math.ceil(config.dwell_s);
  if (fullWindow && ratio < config.sustain_ratio) {
    return currentAbove ? nowMs : null;
  }
  return start;
}

function enoughAboveTicks(
  history: ControllerState['aboveHistory'],
  dwellSeconds: number,
  sustainRatio: number,
): boolean {
  return history.length >= Math.ceil(dwellSeconds) &&
    history.filter((tick) => tick.above).length / history.length >= sustainRatio;
}
