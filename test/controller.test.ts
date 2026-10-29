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

function advance(
  simulation: Simulation,
  seconds: number,
  pace: number,
): ControllerAction[] {
  const actions: ControllerAction[] = [];
  for (let index = 0; index < seconds; index += 1) {
    simulation.nowMs += 1000;
    actions.push(tick(simulation, pace));
  }
  return actions;
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
  tick(simulation, 8);
  const actions = advance(simulation, 5 * config.dwell_s, 8);
  assert.deepEqual(actions.filter((action) => action.type === 'step_up').length, 5);
  assert.equal(simulation.state.step, 5);
  assert.ok(advance(simulation, config.dwell_s, 8)
    .every((action) => action.type === 'none'));
});

test('controller ignores a spike shorter than dwell', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  assert.equal(tick(simulation, 8).type, 'none');
  advance(simulation, 5, 0);
  assert.ok(advance(simulation, config.dwell_s - 5, 8)
    .every((action) => action.type === 'none'));
  assert.equal(simulation.state.step, 0);
});

test('tolerant step-up waits a full dwell with the configured loadtest setpoint', async () => {
  const base = await loadConfig('loadtest');
  const config = { ...base, setpoint_msgs_per_s: 1.5, dwell_s: 5 };
  const simulation = makeSimulation(config);
  const trace = [2.1, 1.9, 2.2, 1.8, 2.1, 2.1];
  const actions: ControllerAction[] = [];
  for (const [index, pace] of trace.entries()) {
    const action = tick(simulation, pace);
    actions.push(action);
    if (index < trace.length - 1) simulation.nowMs += 1000;
  }
  assert.ok(actions.slice(0, 5).every((action) => action.type === 'none'));
  assert.equal(actions.at(-1)?.type, 'step_up');
});

test('one early dip does not reset a tolerant dwell candidate', async () => {
  const base = await loadConfig('loadtest');
  const config = { ...base, setpoint_msgs_per_s: 2, dwell_s: 5 };
  const simulation = makeSimulation(config);
  const actions = [2.1, 1.9, 2.1, 2.1, 2.1, 2.1].map((pace) => {
    const action = tick(simulation, pace);
    simulation.nowMs += 1000;
    return action;
  });
  assert.ok(actions.slice(0, 5).every((action) => action.type === 'none'));
  assert.equal(actions.at(-1)?.type, 'step_up');
});

test('step-up does not trigger when only half of ticks exceed setpoint', async () => {
  const base = await loadConfig('loadtest');
  const config = { ...base, setpoint_msgs_per_s: 1.5, dwell_s: 5 };
  const simulation = makeSimulation(config);
  const actions: ControllerAction[] = [];
  for (let index = 0; index <= 30; index += 1) {
    const pace = index % 2 === 0 ? 2 : 1.4;
    actions.push(tick(simulation, pace));
    simulation.nowMs += 1000;
  }
  assert.ok(actions.every((action) => action.type === 'none'));
});

test('sustain ratio one is strict while point eight tolerates rehearsal dips', async () => {
  const base = await loadConfig('loadtest');
  const trace = [
    2.1, 1.9, 2.2, 2.1, 2.1,
    2.1, 1.9, 2.2, 2.1, 2.1,
    2.1, 1.9, 2.2, 2.1, 2.1,
  ];
  const actionsAt = async (sustainRatio: number): Promise<ControllerAction[]> => {
    const config = {
      ...base,
      setpoint_msgs_per_s: 2,
      dwell_s: 5,
      sustain_ratio: sustainRatio,
    };
    const simulation = makeSimulation(config);
    return trace.map((pace) => {
      const action = tick(simulation, pace);
      simulation.nowMs += 1000;
      return action;
    });
  };
  const strict = await actionsAt(1);
  const tolerant = await actionsAt(0.8);
  assert.equal(strict.some((action) => action.type === 'step_up'), false);
  assert.equal(tolerant.some((action) => action.type === 'step_up'), true);
});

test('sustain ratio one restarts its dwell on the first dip', async () => {
  const base = await loadConfig('loadtest');
  const config = {
    ...base,
    setpoint_msgs_per_s: 2,
    dwell_s: 5,
    sustain_ratio: 1,
  };
  const simulation = makeSimulation(config);
  const trace = [2.1, 1.9, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1];
  const actions = trace.map((pace) => {
    const action = tick(simulation, pace);
    simulation.nowMs += 1000;
    return action;
  });
  assert.equal(actions[6]?.type, 'none');
  assert.equal(actions[7]?.type, 'step_up');
});

test('sustain history does not retain isolated spikes', async () => {
  const base = await loadConfig('loadtest');
  const config = { ...base, setpoint_msgs_per_s: 1.5, dwell_s: 5 };
  const simulation = makeSimulation(config);
  tick(simulation, 3);
  const actions = advance(simulation, 10, 0);
  assert.ok(actions.every((action) => action.type === 'none'));
  assert.equal(simulation.state.step, 0);
});

test('controller holds settings in the hysteresis band', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  assert.equal(tick(simulation, 4).type, 'none');
  assert.ok(advance(simulation, 60, 4).every((action) => action.type === 'none'));
  assert.equal(simulation.state.step, 0);
});

test('controller releases one step at a time after release hold', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  tick(simulation, 8);
  advance(simulation, 4 * config.dwell_s, 8);
  assert.equal(simulation.state.step, 4);
  assert.equal(tick(simulation, 0).type, 'none');
  assert.equal(advance(simulation, config.release_hold_s, 0).at(-1)?.type, 'step_down');
  assert.equal(simulation.state.step, 3);
  assert.equal(advance(simulation, config.dwell_s, 0).at(-1)?.type, 'step_down');
  assert.equal(simulation.state.step, 2);
  assert.equal(advance(simulation, config.dwell_s, 0).at(-1)?.type, 'step_down');
  assert.equal(simulation.state.step, 1);
  assert.equal(advance(simulation, config.dwell_s, 0).at(-1)?.type, 'restore');
  assert.equal(simulation.state.step, 0);
});

test('warning lowers setpoint and expires after its hold', async () => {
  const config = await configPromise;
  const simulation = makeSimulation(config);
  simulation.warnings = 0;
  assert.equal(tick(simulation, 5).type, 'none');
  assert.equal(advance(simulation, config.dwell_s, 5).at(-1)?.type, 'step_up');
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
  const simulation = makeSimulation({ ...config, sustain_ratio: 0.8 });
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
