export const GAUGE_HUB = Object.freeze({ x: 200, y: 170 });
export const GAUGE_RADIUS = 140;

export function paceAngle(value, setpoint) {
  if (!Number.isFinite(value) || !Number.isFinite(setpoint) || setpoint <= 0) {
    return 180;
  }
  const fraction = Math.min(1, Math.max(0, value / (setpoint * 2.5)));
  return 180 - fraction * 180;
}

export function arcPath(radius = GAUGE_RADIUS, hub = GAUGE_HUB) {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : GAUGE_RADIUS;
  const left = hub.x - safeRadius;
  const right = hub.x + safeRadius;
  return `M ${left} ${hub.y} A ${safeRadius} ${safeRadius} 0 0 1 ${right} ${hub.y}`;
}

export function pointOnArc(value, setpoint, radius = GAUGE_RADIUS, hub = GAUGE_HUB) {
  const angle = paceAngle(value, setpoint) * Math.PI / 180;
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : GAUGE_RADIUS;
  return {
    x: hub.x + Math.cos(angle) * safeRadius,
    y: hub.y - Math.sin(angle) * safeRadius,
  };
}

export function tickEndpoints(
  value,
  setpoint,
  innerRadius = 128,
  outerRadius = 148,
  hub = GAUGE_HUB,
) {
  const angle = paceAngle(value, setpoint) * Math.PI / 180;
  return {
    inner: polarPoint(angle, innerRadius, hub),
    outer: polarPoint(angle, outerRadius, hub),
  };
}

export function labelAnchor(value, setpoint, radius = 150, hub = GAUGE_HUB) {
  const angle = paceAngle(value, setpoint) * Math.PI / 180;
  return polarPoint(angle, radius, hub);
}

function polarPoint(angle, radius, hub) {
  return {
    x: hub.x + Math.cos(angle) * radius,
    y: hub.y - Math.sin(angle) * radius,
  };
}

export function stepDots(step, count = 5) {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 5;
  const safeStep = Number.isFinite(step) ? Math.floor(step) : 0;
  const active = Math.min(safeCount, Math.max(0, safeStep));
  return Array.from({ length: safeCount }, (_, index) => index < active);
}

export function warningChip(warning) {
  if (warning === 'gift') return 'gift wave';
  if (warning === 'raid') return 'raid';
  return null;
}

export function createWarningMemory() {
  return { kind: null, untilMs: 0 };
}

export function warningChipFromState(state, nowMs, memory) {
  if (state.warning) {
    if (memory.kind !== state.warning || nowMs >= memory.untilMs) {
      memory.kind = state.warning;
      memory.untilMs = nowMs + state.warningHoldSeconds * 1000;
    }
    return state.warning;
  }
  if (state.mode === 'simulation' && memory.kind && nowMs < memory.untilMs) {
    return memory.kind;
  }
  memory.kind = null;
  memory.untilMs = 0;
  return null;
}

export function updateWarningElement(element, state, nowMs, memory) {
  const chip = warningChip(warningChipFromState(state, nowMs, memory));
  element.textContent = chip ?? '';
  element.classList.toggle('hidden', chip === null);
  return chip !== null;
}

export function isStale(nowMs, lastSignalMs, timeoutMs = 5000) {
  return !Number.isFinite(nowMs) || !Number.isFinite(lastSignalMs) ||
    nowMs - lastSignalMs >= timeoutMs;
}
