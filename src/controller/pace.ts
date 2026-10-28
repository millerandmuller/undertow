export type PaceState = {
  windowMs: number;
  timestampsMs: number[];
};

export function createPaceState(windowSeconds: number): PaceState {
  return { windowMs: windowSeconds * 1000, timestampsMs: [] };
}

export function record(state: PaceState, timestampMs: number): PaceState {
  const earliest = timestampMs - state.windowMs;
  const timestampsMs = state.timestampsMs.filter((stamp) => stamp >= earliest);
  timestampsMs.push(timestampMs);
  return { windowMs: state.windowMs, timestampsMs };
}

export function rate(state: PaceState, nowMs: number): number {
  const earliest = nowMs - state.windowMs;
  const count = state.timestampsMs.filter((stamp) => stamp > earliest && stamp <= nowMs).length;
  return count / (state.windowMs / 1000);
}
