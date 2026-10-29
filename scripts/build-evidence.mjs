import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// These turn mappings were recorded when each turn was reviewed.
const TURN_COMMITS = new Map([
  ['c6c81b4', '003'],
  ['f8ad96b', '003'],
  ['790500b', '003'],
  ['fc7031c', '004'],
  ['0602d21', '004'],
  ['65be6a0', '004'],
  ['8fddfb4', '004'],
  ['410c6aa', '009'],
  ['c2325db', '010'],
  ['8943ce0', '011'],
  ['bc3d5fc', '011'],
  ['6f94e4b', '011'],
  ['6f5595f', '012'],
  ['b376fdf', '012'],
  ['36f8ea3', '012'],
  ['0247ed6', '013'],
  ['04b6fca', '014'],
  ['d6e9648', '015'],
  ['d29bff9', '016'],
  ['98ce7ce', '017'],
  ['f8875f5', '017'],
  ['f6bf528', '017'],
  ['c0dbe89', '017'],
  ['4ca7295', '018'],
  ['9972876', '018'],
  ['cc876d2', '018'],
  ['16bdf0d', '018'],
  ['3f05022', '018'],
]);

const repo = option('--repo') ?? process.cwd();
const output = option('--output') ?? resolve('docs/BUILD_EVIDENCE.md');
const rows = readHistory(repo);
const known = new Set(rows.map((row) => row.hash));
for (const hash of TURN_COMMITS.keys()) {
  if (!known.has(hash)) process.stderr.write(`Turn mapping not found: ${hash}\n`);
}
await writeFile(output, renderEvidence(rows));

function readHistory(directory) {
  const data = execFileSync('git', [
    'log', 'main', '--reverse', '--format=%h%x09%aI%x09%s',
  ], { cwd: directory, encoding: 'utf8' });
  return data.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, date, ...subjectParts] = line.split('\t');
    return {
      hash: hash ?? '',
      date: date ?? '',
      subject: safeSubject(subjectParts.join('\t')),
    };
  });
}

function renderEvidence(history) {
  const lines = [
    '# Build evidence',
    '',
    'This file records the commits on `main`, oldest first, with their author',
    'dates and subjects. It is generated from this repository’s `git log`.',
    'This file is generated before the commit that contains it, so that newest',
    'commit is not listed. Two subject lines (`452034d` and `f8ad96b`) are shown',
    'with product names removed and replaced with neutral wording.',
    '',
    '| Commit | Author date | Subject | Turn |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of history) {
    const turn = TURN_COMMITS.get(row.hash) ?? '-';
    lines.push(`| ${row.hash} | ${row.date} | ${row.subject} | ${turn} |`);
  }
  lines.push(
    '',
    'Turn numbers are the numbered build requests sent into the single Codex',
    'thread. Commits without a number were made in turns whose mapping was not',
    'recorded. The thread count in the README is counted from the session file;',
    'numbered requests and counted turns differ because requests were resent or split.',
    '',
  );
  return lines.join('\n');
}

function safeSubject(subject) {
  return subject
    .replace(/\bOBS browser source\b/gi, 'browser source')
    .replace(/\bnpm commands\b/gi, 'package commands')
    .replace(/\bOBS\b/g, 'browser source')
    .replace(/\bnpm\b/gi, 'package')
    .replaceAll('|', '\\|');
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
