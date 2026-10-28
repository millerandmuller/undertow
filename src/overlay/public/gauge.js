export function paceAngle(value, setpoint) {
  if (!Number.isFinite(value) || !Number.isFinite(setpoint) || setpoint <= 0) {
    return 180;
  }
  const fraction = Math.min(1, Math.max(0, value / (setpoint * 2.5)));
  return 180 - fraction * 180;
}

export function stepDots(step, count = 5) {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 5;
  const safeStep = Number.isFinite(step) ? Math.floor(step) : 0;
  const active = Math.min(safeCount, Math.max(0, safeStep));
  return Array.from({ length: safeCount }, (_, index) => index < active);
}
