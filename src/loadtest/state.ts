import { readJson } from '../util/files.ts';

export type LoadtestState = {
  active: boolean;
  accounts: number;
  rate_per_account: number;
  updated_at: string;
};

export function loadtestBadge(
  state: LoadtestState | null,
  nowMs: number,
): string | null {
  if (!state?.active || !Number.isFinite(Date.parse(state.updated_at))) return null;
  const age = nowMs - Date.parse(state.updated_at);
  if (age < 0 || age > 10_000) return null;
  return `load test, ${state.accounts} accounts`;
}

export async function readLoadtestBadge(
  path: string,
  nowMs: number,
): Promise<string | null> {
  try {
    return loadtestBadge(await readJson<LoadtestState>(path), nowMs);
  } catch {
    return null;
  }
}
