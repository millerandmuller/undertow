import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = ['src', 'test'];
const failures = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith('.ts')) await checkFile(path);
  }
}

async function checkFile(path) {
  const lines = (await readFile(path, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    if (line.length > 100) failures.push(`${path}:${index + 1}: line exceeds 100 characters`);
    if (path.startsWith('src/') && /:\s*any\b|\bas any\b/.test(line)) {
      failures.push(`${path}:${index + 1}: any type is not allowed`);
    }
  });
}

for (const root of roots) await visit(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Source and test checks passed.');
}
