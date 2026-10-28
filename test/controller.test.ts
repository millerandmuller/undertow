import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, type ProfileConfig } from '../src/config.ts';
import {
  decide,
  initialControllerState,
  type ControllerAction,
  type ControllerState,
} from '../src/controller/controller.ts';
import { createPaceState, rate, record } from '../src/controller/pace.ts';
import { createDisplayState } from '../src/run.ts';

const configPromise = loadConfig('real');

type Simulation = {
  config: ProfileConfig;
  state: ControllerState;
  nowMs: number;
  warnings: number | null;
  overrideUntilMs: number;
};

function tick(simulation: Simulation, pace: number): ControllerAction {
  const result = decide(simulation.state, {
    nowMs: simulation.nowMs,
    rate: pace,
    warnings: simulation.warnings,
    manualOverrideUntilMs: simulation.overrideUntilMs,
  }, simulation.config);
  simulation.state = result.state;
  return result.action;
}

test('pace counter reports messages per second over a rolling window', () => {
  let state = createPaceState(10);
  for (const stamp of [100, 1100, 2100, 3100]) state = record(state, stamp);
  assert.equal(rate(state, 3100), 0.4);
  assert.equal(rate(state, 13100), 0);
});

test('controller ramp climbs one step per dwell', async () => {
  const config = await configPromise;
  const simulation: Simulation = {
    config,
    state: initialControllerState(),
    nowMs: 0,
    warnings: null,
    overrideUntilMs: 0,
  };
  const actions: ControllerAction['type'][] = [];
  for (let step = 0; step < 5; step++) {
    simulation.nowMs = step * config.dwell_s * 1000;
    actions.push(tick(simulation, 8).type);
  }
  assert.deepEqual(actions, ['none', 'step_up', 'step_up', 'step_up', 'step_up']);
  simulation.nowMs = 5 * config.dwell_s * 1000;
  assert.equal(tick(simulation, 8).type, 'step_up');
  assert.equal(simulation.state.step, 5);
  simulation.nowMs += config.dwell_s * 1000;
  assert.equal(tick(simulation, 8).type, 'none');
});

test('controller ignores a spike shorter than dwell', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  assert.equal(tick(simulation, 8).type, 'none');
  simulation.nowMs = 5000;
  assert.equal(tick(simulation, 0).type, 'none');
  simulation.nowMs = config.dwell_s * 1000;
  assert.equal(tick(simulation, 8).type, 'none');
  assert.equal(simulation.state.step, 0);
});

test('controller holds settings in the hysteresis band', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  assert.equal(tick(simulation, 4).type, 'none');
  simulation.nowMs = 60_000;
  assert.equal(tick(simulation, 4).type, 'none');
  assert.equal(simulation.state.step, 0);
});

test('controller releases one step at a time after release hold', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  for (let step = 0; step <= 4; step++) {
    simulation.nowMs = step * config.dwell_s * 1000;
    tick(simulation, 8);
  }
  assert.equal(simulation.state.step, 4);
  assert.equal(tick(simulation, 0).type, 'none');
  simulation.nowMs += config.release_hold_s * 1000;
  assert.equal(tick(simulation, 0).type, 'step_down');
  assert.equal(simulation.state.step, 3);
  simulation.nowMs += config.release_hold_s * 1000;
  assert.equal(tick(simulation, 0).type, 'step_down');
  assert.equal(simulation.state.step, 2);
  simulation.nowMs += config.release_hold_s * 1000;
  assert.equal(tick(simulation, 0).type, 'step_down');
  assert.equal(simulation.state.step, 1);
  simulation.nowMs += config.release_hold_s * 1000;
  assert.equal(tick(simulation, 0).type, 'restore');
  assert.equal(simulation.state.step, 0);
});

test('warning lowers setpoint and expires after its hold', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  simulation.warnings = 0;
  assert.equal(tick(simulation, 5).type, 'none');
  simulation.nowMs = config.dwell_s * 1000;
  assert.equal(tick(simulation, 5).type, 'step_up');
  simulation.nowMs += 1000;
  simulation.warnings = null;
  assert.equal(tick(simulation, 5).type, 'none');
  assert.equal(simulation.state.step, 1);
});

test('manual override yields and holds the current step', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  simulation.overrideUntilMs = 30_000;
  assert.equal(tick(simulation, 20).type, 'yield');
  simulation.nowMs = 30_000;
  assert.equal(tick(simulation, 20).type, 'none');
  assert.equal(simulation.state.step, 0);
});

test('seeded rate fuzz trace never reverses within dwell', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  let seed = 0x51f15e;
  let previousMove: { direction: 'up' | 'down'; at: number } | null = null;
  for (let index = 0; index < 12000; index++) {
    seed = (seed * 48271) % 0x7fffffff;
    const value = seed / 0x7fffffff;
    const pace = value < 0.55 ? value * 10 : value * 20;
    simulation.nowMs = index * 1000;
    const action = tick(simulation, pace);
    const direction = directionOf(action);
    if (direction && previousMove && direction !== previousMove.direction) {
      assert.ok(simulation.nowMs - previousMove.at >= config.dwell_s * 1000);
    }
    if (direction) previousMove = { direction, at: simulation.nowMs };
  }
});

function directionOf(action: ControllerAction): 'up' | 'down' | null {
  if (action.type === 'step_up') return 'up';
  if (action.type === 'step_down' || action.type === 'restore') return 'down';
  return null;
}

function makeSimulation(config: ProfileConfig): Simulation {
  return {
    config,
    state: initialControllerState(),
    nowMs: 0,
    warnings: null,
    overrideUntilMs: 0,
  };
}

test('display state publishes updates to subscribers', () => {
  const display = createDisplayState(6);
  const steps: number[] = [];
  const unsubscribe = display.subscribe((state) => steps.push(state.step));
  display.publish({ pace: 8, setpoint: 4, step: 1, lastReason: 'high pace' });
  unsubscribe();
  display.publish({ pace: 9, setpoint: 6, step: 2, lastReason: 'later' });
  assert.deepEqual(steps, [0, 1]);
});
