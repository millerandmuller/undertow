export type LoadtestRate = {
  rate: number;
  burstSeconds: number;
  taperSeconds: number;
};

export function parseLoadtestRate(
  rate: number,
  burstSeconds: number,
  taperSeconds: number,
): LoadtestRate {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('--rate must be greater than 0');
  }
  if (rate > 0.6) {
    throw new Error(
      '--rate exceeds Twitch plain-user limit: 20 messages per 30 seconds',
    );
  }
  if (!Number.isFinite(burstSeconds) || burstSeconds < 0) {
    throw new Error('--burst must be zero or greater');
  }
  if (!Number.isFinite(taperSeconds) || taperSeconds < 0) {
    throw new Error('--taper must be zero or greater');
  }
  return { rate, burstSeconds, taperSeconds };
}

export function rateAt(elapsedSeconds: number, plan: LoadtestRate): number {
  if (elapsedSeconds < plan.burstSeconds) return plan.rate;
  if (plan.taperSeconds === 0) return 0;
  const taperProgress = (elapsedSeconds - plan.burstSeconds) / plan.taperSeconds;
  return plan.rate * Math.max(0, 1 - taperProgress);
}

export function deterministicUnit(seed: string, index: number): number {
  let value = hashSeed(seed) ^ Math.imul(index + 1, 0x9e3779b1);
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x100000000;
}

export function intervalMs(
  login: string,
  sequence: number,
  rate: number,
): number {
  const jitter = 0.9 + deterministicUnit(login, sequence) * 0.2;
  return 1000 / rate * jitter;
}

export class RollingMessageLimiter {
  private readonly windowMs: number;
  private readonly maximum: number;
  private sentAt: number[] = [];

  constructor(maximum = 18, windowMs = 30_000) {
    this.maximum = maximum;
    this.windowMs = windowMs;
  }

  nextAllowedAt(nowMs: number): number {
    this.prune(nowMs);
    if (this.sentAt.length < this.maximum) return nowMs;
    return (this.sentAt[0] ?? nowMs) + this.windowMs;
  }

  record(nowMs: number): boolean {
    this.prune(nowMs);
    if (this.sentAt.length >= this.maximum) return false;
    this.sentAt.push(nowMs);
    return true;
  }

  private prune(nowMs: number): void {
    this.sentAt = this.sentAt.filter((time) => nowMs - time < this.windowMs);
  }
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}
