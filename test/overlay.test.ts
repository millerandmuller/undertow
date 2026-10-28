import assert from 'node:assert/strict';
import test from 'node:test';
import { createDisplayState } from '../src/run.ts';
import { startOverlayServer } from '../src/overlay/server.ts';
import { paceAngle, stepDots } from '../src/overlay/public/gauge.js';
import { simulationOverlayOptions } from '../src/sim/overlay-state.ts';

async function nextText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  return new TextDecoder().decode(chunk.value);
}

test('gauge math maps range, clamps, and handles invalid input', () => {
  assert.equal(paceAngle(0, 2), 180);
  assert.equal(paceAngle(2, 2), 108);
  assert.equal(paceAngle(5, 2), 0);
  assert.equal(paceAngle(8, 2), 0);
  assert.equal(paceAngle(Number.NaN, 2), 180);
  assert.equal(paceAngle(1, 0), 180);
  assert.deepEqual(stepDots(0), [false, false, false, false, false]);
  assert.deepEqual(stepDots(3), [true, true, true, false, false]);
  assert.deepEqual(stepDots(9), [true, true, true, true, true]);
  assert.deepEqual(stepDots(Number.NaN), [false, false, false, false, false]);
});

test('simulation projection labels modeled pace without changing the run state', () => {
  const display = createDisplayState(2, 'live');
  display.publish({
    pace: 1.5,
    setpoint: 2,
    step: 1,
    lastReason: 'chat hit 1.5 msgs/s',
  });
  const project = simulationOverlayOptions(true).mapState;
  assert.ok(project);
  const state = project(display);
  assert.equal(state.mode, 'simulation');
  assert.equal(state.paceSource, 'modeled');
  assert.equal(state.badge, 'SIMULATION');
  assert.match(state.lastReason, /1.5 msgs\/s \(modeled\)/);
  assert.equal(display.mode, 'live');
  assert.equal(display.paceSource, 'measured');
});

test('overlay serves page and assets with their content types', async () => {
  const display = createDisplayState(6, 'live');
  const server = await startOverlayServer(display, 0);
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /undertow pace/);
    for (const [path, type] of [
      ['/overlay.css', 'text/css'],
      ['/overlay.js', 'text/javascript'],
      ['/gauge.js', 'text/javascript'],
    ]) {
      const asset = await fetch(new URL(path, server.url));
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type') ?? '', new RegExp(type));
    }
  } finally {
    await server.stop();
  }
});

test('overlay state, event stream ordering, heartbeat, and stop cleanup', async () => {
  const display = createDisplayState(2, 'live');
  display.publish({
    pace: 0.5,
    setpoint: 2,
    step: 1,
    lastReason: 'slow mode 3 s',
    stepLabel: 'slow 3 s',
    warning: 'gift',
    ratelimitRemaining: 450,
    ratelimitLimit: 800,
  });
  const server = await startOverlayServer(display, 0, { heartbeatIntervalMs: 25 });
  const response = await fetch(new URL('/state', server.url));
  assert.deepEqual(await response.json(), {
    pace: 0.5,
    setpoint: 2,
    step: 1,
    mode: 'live',
    stepLabel: 'slow 3 s',
    stepCount: 5,
    warning: 'gift',
    ratelimitRemaining: 450,
    ratelimitLimit: 800,
    paceSource: 'measured',
    badge: null,
    lastReason: 'slow mode 3 s',
  });

  const events = await fetch(new URL('/events', server.url));
  const reader = events.body?.getReader();
  assert.ok(reader);
  const first = await nextText(reader);
  assert.match(first, /event: state/);
  assert.match(first, /"stepLabel":"slow 3 s"/);
  display.publish({
    pace: 1.25,
    setpoint: 2,
    step: 2,
    lastReason: 'slowing chat',
    stepLabel: 'slow 10 s',
  });
  display.publish({
    pace: 1.5,
    setpoint: 2,
    step: 3,
    lastReason: 'holding settings',
    stepLabel: 'slow 30 s',
  });
  let updates = '';
  for (let index = 0; index < 5 &&
    (!updates.includes('\"step\":2') || !updates.includes('\"step\":3')); index += 1) {
    updates += await nextText(reader);
  }
  assert.ok(updates.indexOf('"step":2') < updates.indexOf('"step":3'));
  let heartbeat = '';
  for (let index = 0; index < 4 && !heartbeat.includes(': heartbeat'); index += 1) {
    heartbeat += await nextText(reader);
  }
  assert.match(heartbeat, /: heartbeat/);
  await server.stop();
  const closed = await reader.read();
  assert.equal(closed.done, true);
  await reader.cancel().catch(() => undefined);
});

test('overlay rejects traversal and unknown paths', async () => {
  const server = await startOverlayServer(createDisplayState(6), 0);
  try {
    const traversal = await fetch(new URL('/%2e%2e/package.json', server.url));
    assert.equal(traversal.status, 404);
    const unknown = await fetch(new URL('/private.txt', server.url));
    assert.equal(unknown.status, 404);
  } finally {
    await server.stop();
  }
});
