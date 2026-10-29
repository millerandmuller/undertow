import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ReportProposal } from './schema.ts';

const CONFIG_FIELDS = [
  'setpoint_msgs_per_s',
  'dwell_s',
  'release_hold_s',
] as const;

export async function updateConfigAtomically(
  path: string,
  profile: string,
  proposal: ReportProposal,
): Promise<void> {
  const original = await readFile(path, 'utf8');
  const updated = replaceProfileFields(original, profile, proposal);
  JSON.parse(updated);
  const fileStat = await stat(path);
  const temporary = join(dirname(path), `.undertow-config-${process.pid}.tmp`);
  try {
    await writeFile(temporary, updated, { mode: fileStat.mode & 0o777 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function replaceProfileFields(
  text: string,
  profile: string,
  proposal: ReportProposal,
): string {
  const profileStart = findProfileStart(text, profile);
  const profileEnd = matchingBrace(text, profileStart);
  let section = text.slice(profileStart, profileEnd + 1);
  const values = {
    setpoint_msgs_per_s: proposal.setpoint,
    dwell_s: proposal.dwell_s,
    release_hold_s: proposal.release_hold_s,
  };
  for (const field of CONFIG_FIELDS) {
    const pattern = new RegExp(
      `(^[ \\t]*"${field}"\\s*:\\s*)[^,\\r\\n]+`,
      'gm',
    );
    const matches = [...section.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`Cannot find ${profile}.${field} in config`);
    section = section.replace(pattern, (_match, prefix: string) =>
      `${prefix}${values[field]}`);
  }
  return `${text.slice(0, profileStart)}${section}${text.slice(profileEnd + 1)}`;
}

function findProfileStart(text: string, profile: string): number {
  const pattern = new RegExp(`"${escapeRegExp(profile)}"\\s*:\\s*\\{`, 'g');
  const match = pattern.exec(text);
  if (!match) throw new Error(`Profile ${profile} is missing from undertow.config.json`);
  return text.indexOf('{', match.index + match[0].indexOf(':'));
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  throw new Error('Config profile has unbalanced braces');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
