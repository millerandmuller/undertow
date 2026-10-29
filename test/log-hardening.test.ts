import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readStormHash, readPaceLabels } from '../src/report/command.ts';
import { readLabeledStorm } from '../src/report/storm.ts';
import { rotateStormLog } from '../src/util/storm-log.ts';

test('rotation archives a nonempty log with mode 600 and creates a fresh current log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-rotation-'));
  const path = join(directory, 'storm.log.jsonl');
  try {
    assert.equal(await rotateStormLog(path), null);
    await writeFile(path, '');
    assert.equal(await rotateStormLog(path), null);
    await writeFile(path, 'old run\n', { mode: 0o644 });
    const archive = await rotateStormLog(path, new Date('2026-01-02T03:04:05.000Z'));
    assert.ok(archive);
    assert.equal(await readFile(archive, 'utf8'), 'old run\n');
    assert.equal((await stat(archive)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, 'utf8'), '');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy prefix is ignored and the hash covers only labeled lines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-legacy-'));
  const path = join(directory, 'storm.log.jsonl');
  const labeled = '{"pace_source":"modeled","action":"step_up"}\n';
  try {
    await writeFile(path, '{}\n{}\n' + labeled);
    const output: string[] = [];
    assert.equal(await readStormHash(path, true, (line) => output.push(line)),
      createHash('sha256').update(labeled).digest('hex'));
    assert.deepEqual(output, ['ignored 2 legacy lines without pace_source']);
    assert.equal((await readPaceLabels(path)).overall, 'modeled');
    assert.equal((await readLabeledStorm(path)).text, labeled);
    await writeFile(path, labeled + '{}\n');
    await assert.rejects(readLabeledStorm(path), /line 2.*missing or unknown pace_source/);
    await writeFile(path, '{}\n{}\n');
    await assert.rejects(readLabeledStorm(path), /no labeled lines/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


