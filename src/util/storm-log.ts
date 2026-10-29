import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function rotateStormLog(path: string, now = new Date()): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!text.trim()) return null;
  let timestamp = now.getTime();
  let archive: string;
  while (true) {
    archive = join(dirname(path), `storm.log.${new Date(timestamp).toISOString()}.jsonl`);
    try {
      await readFile(archive);
      timestamp += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  await chmod(path, 0o600);
  await rename(path, archive);
  await writeFile(path, '', { mode: 0o600 });
  return archive;
}
