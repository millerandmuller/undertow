import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, selectedProfile } from '../src/config.ts';
import {
  restoreNotice,
  stepDownNotice,
  stepUpNotice,
  warningNotice,
} from '../src/notices/notices.ts';

const profile = await loadConfig('real');

test('config loads named profiles and validates their ladder', async () => {
  const real = await loadConfig('real');
  const loadtest = await loadConfig('loadtest');
  assert.equal(real.setpoint_msgs_per_s, 6);
  assert.equal(real.dwell_s, 20);
  assert.deepEqual(real.ladder.map((step) => step.kind), [
    'slow', 'slow', 'slow', 'followers', 'emote',
  ]);
  assert.equal(loadtest.setpoint_msgs_per_s, 1.5);
  assert.equal(loadtest.dwell_s, 15);
  assert.equal(loadtest.release_hold_s, 30);
  assert.equal(loadtest.setpoint_msgs_per_s * loadtest.release_ratio, 0.75);
  assert.equal(real.sustain_ratio, 0.8);
  assert.equal(loadtest.sustain_ratio, 0.8);
  await assert.rejects(loadConfig('other'), /must be real or loadtest/);
});

test('config rejects invalid ladder actuator values', async () => {
  const directory = await mkdtemp('/tmp/undertow-config-');
  const path = join(directory, 'config.json');
  try {
    const invalid = {
      real: { ...profile, ladder: [
        { kind: 'slow', slow_mode_wait_time: 121 },
        ...profile.ladder.slice(1).map((step) => ({
          kind: step.kind,
          ...step.patch,
        })),
      ] },
    };
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(loadConfig('real', path), /integer from 3 to 120/);
    invalid.real.ladder[0] = { kind: 'slow', slow_mode_wait_time: 3 };
    invalid.real.ladder[3] = {
      kind: 'followers',
      follower_mode: true,
      follower_mode_duration: 129601,
    };
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(loadConfig('real', path), /integer from 0 to 129600/);
    await writeFile(path, JSON.stringify({
      real: rawProfile(0),
    }));
    await assert.rejects(loadConfig('real', path), /sustain_ratio must be a positive/);
    await writeFile(path, JSON.stringify({
      real: rawProfile(1.01),
    }));
    await assert.rejects(loadConfig('real', path), /sustain_ratio must be at most 1/);
    await writeFile(path, JSON.stringify({
      real: rawProfile(1),
    }));
    assert.equal((await loadConfig('real', path)).sustain_ratio, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function rawProfile(sustainRatio: number): Record<string, unknown> {
  return {
    ...profile,
    sustain_ratio: sustainRatio,
    ladder: profile.ladder.map((step) => ({ kind: step.kind, ...step.patch })),
  };
}

test('profile flag overrides profile environment variable', () => {
  const previous = process.env.UNDERTOW_PROFILE;
  process.env.UNDERTOW_PROFILE = 'loadtest';
  assert.equal(selectedProfile(['--profile', 'real']), 'real');
  assert.equal(selectedProfile([]), 'loadtest');
  if (previous === undefined) delete process.env.UNDERTOW_PROFILE;
  else process.env.UNDERTOW_PROFILE = previous;
});

test('notice strings are plain sentences within chat limit', () => {
  const step = stepUpNotice(profile.ladder[1], 2, 14, profile);
  const gift = warningNotice('gift', 14, 2, profile);
  const raid = warningNotice('raid', 14, 2, profile);
  const restore = restoreNotice(2, 0, profile);
  const easingSlow = stepDownNotice(profile.ladder[1], 2, 2.4, profile);
  const easingFollowers = stepDownNotice(profile.ladder[3], 4, 3.1, profile);
  assert.equal(step.message, 'Slow mode 10 s: chat hit 14 msgs/s. Back to normal when it drops ' +
    'under 3 msgs/s for 30 s.');
  assert.match(gift.message, /a gift wave is landing/);
  assert.match(raid.message, /a raid is landing/);
  assert.equal(restore.message, 'Chat is back to normal. Settings restored.');
  assert.equal(
    easingSlow.message,
    'Easing to slow mode 10 s: chat is at 2.4 msgs/s. ' +
      'Next step down when it stays under 3 msgs/s for 30 s.',
  );
  assert.match(easingFollowers.message, /followers-only 10 min/);
  assert.match(easingFollowers.overlayText, /step 4 of 5/);
  for (const notice of [step, easingSlow, easingFollowers, gift, raid, restore]) {
    assert.ok(notice.message.length <= 500);
    assert.equal(notice.message.endsWith('.'), true);
    assert.equal(notice.overlayText, notice.overlayText.toLowerCase());
  }
});
