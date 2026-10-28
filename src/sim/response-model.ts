import { readFile } from 'node:fs/promises';

export type ResponseModel = {
  version: 1;
  label: 'synthetic assumption, not measured';
  note: string;
  pass_through_by_step: number[];
};

const DEFAULT_MODEL_PATH = new URL('../../replays/response-model.json', import.meta.url);

export function parseResponseModel(value: unknown): ResponseModel {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('response model must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('response model version must be 1');
  if (raw.label !== 'synthetic assumption, not measured') {
    throw new Error('response model label must identify its values as synthetic assumptions');
  }
  if (typeof raw.note !== 'string' || raw.note.length === 0) {
    throw new Error('response model note is required');
  }
  if (!Array.isArray(raw.pass_through_by_step) || raw.pass_through_by_step.length !== 6) {
    throw new Error('response model needs one fraction for baseline and each of five steps');
  }
  const fractions = raw.pass_through_by_step.map((fraction, index) => {
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) ||
      fraction < 0 || fraction > 1) {
      throw new Error(`response model fraction ${index} must be from 0 to 1`);
    }
    return fraction;
  });
  if (fractions[0] !== 1) {
    throw new Error('response model baseline fraction must be 1');
  }
  return {
    version: 1,
    label: raw.label,
    note: raw.note,
    pass_through_by_step: fractions,
  };
}

export async function loadResponseModel(
  path: URL | string = DEFAULT_MODEL_PATH,
): Promise<ResponseModel> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseResponseModel(parsed);
}

function seededFraction(offsetMs: number, index: number): number {
  let value = (Math.trunc(offsetMs) ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 0x1_0000_0000;
}

export function messagePassesModel(
  offsetMs: number,
  index: number,
  fraction: number,
): boolean {
  return seededFraction(offsetMs, index) < fraction;
}

export function labelRateText(value: string, label: 'modeled' | 'recorded'): string {
  const paceLabeled = value.replace(
    /(chat hit|chat is at) ([0-9]+(?:\.[0-9]+)?) msgs\/s/g,
    `$1 $2 msgs/s (${label})`,
  );
  return paceLabeled.replace(/under ([0-9]+(?:\.[0-9]+)?) msgs\/s/g,
    'under $1 msgs/s (configured)');
}
