import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('build evidence generator lists a temporary main history oldest first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'undertow-evidence-'));
  const output = join(directory, 'evidence.md');
  const script = new URL('../scripts/build-evidence.mjs', import.meta.url);
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: directory,
    });
    execFileSync('git', ['config', 'user.name', 'Evidence Test'], {
      cwd: directory,
    });
    execFileSync('git', ['config', 'user.email', 'evidence@example.invalid'], {
      cwd: directory,
    });
    await writeFile(join(directory, 'item.txt'), 'first\n');
    commitFile(directory, 'Prepare npm commands', '2020-01-01T00:00:00Z');
    await writeFile(join(directory, 'item.txt'), 'second\n');
    commitFile(directory, 'Document OBS browser source setup',
      '2020-01-02T00:00:00Z');
    execFileSync(process.execPath, [
      script.pathname,
      '--repo',
      directory,
      '--output',
      output,
    ], { stdio: 'ignore' });
    const evidence = await readFile(output, 'utf8');
    assert.ok(evidence.indexOf('Prepare package commands') <
      evidence.indexOf('Document browser source setup'));
    assert.equal(evidence.includes('npm'), false);
    assert.equal(evidence.includes('OBS'), false);
    assert.match(evidence, /\| - \|\n/);
    assert.match(evidence, /2020-01-01T00:00:00Z/);
    assert.match(evidence, /2020-01-02T00:00:00Z/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function commitFile(directory: string, subject: string, date: string): void {
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  execFileSync('git', ['add', 'item.txt'], { cwd: directory });
  execFileSync('git', ['commit', '--quiet', '-m', subject], {
    cwd: directory,
    env: environment,
  });
}
