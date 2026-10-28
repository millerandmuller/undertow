import type { ProfileConfig } from '../config.ts';

export type ControllerState = {
  step: number;
  lastMoveMs: number;
  lastDirection: 'up' | 'down' | null;
  aboveSinceMs: number | null;
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
    belowSinceMs: null,
  };
}

function idle(state: ControllerState): ControllerState {
  return { ...state, aboveSinceMs: null, belowSinceMs: null };
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

  if (input.rate > effectiveSetpoint) {
    const aboveSinceMs = state.aboveSinceMs ?? input.nowMs;
    const next = { ...state, aboveSinceMs, belowSinceMs: null };
    const sustained = input.nowMs - aboveSinceMs >= config.dwell_s * 1000;
    if (sustained && canMove && !reversalBlocked(state, 'up', input.nowMs, config)) {
      if (state.step < config.ladder.length) {
        const step = state.step + 1;
        return {
          state: moved(state, step, 'up', input.nowMs),
          action: { type: 'step_up', step },
        };
      }
    }
    return { state: next, action: { type: 'none' } };
  }

  if (input.rate < releaseLevel) {
    const belowSinceMs = state.belowSinceMs ?? input.nowMs;
    const next = { ...state, belowSinceMs, aboveSinceMs: null };
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

  return { state: idle(state), action: { type: 'none' } };
}
