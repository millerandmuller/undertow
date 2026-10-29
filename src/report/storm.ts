import { readFile } from 'node:fs/promises';

export type LabeledStormEntry = {
  pace_source: 'recorded' | 'modeled';
  action?: string;
};

export async function readLabeledStorm(path: string): Promise<{
  text: string;
  entries: LabeledStormEntry[];
  ignored: number;
}> {
  const text = await readFile(path, 'utf8');
  if (!text.trim()) throw new Error('Storm log is empty; run Undertow during a storm first');
  const entries: LabeledStormEntry[] = [];
  const used: string[] = [];
  let ignored = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Storm log line ${index + 1} is invalid JSON`);
    }
    const object = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown> : null;
    if (object && object.pace_source === undefined && entries.length === 0) {
      ignored += 1;
      continue;
    }
    if (!object || !['recorded', 'modeled'].includes(String(object.pace_source))) {
      throw new Error(`Storm log line ${index + 1} has missing or unknown pace_source`);
    }
    entries.push(object as LabeledStormEntry);
    used.push(line);
  }
  if (entries.length === 0) throw new Error('Storm log has no labeled lines with pace_source');
  return { text: `${used.join('\n')}\n`, entries, ignored };
}
