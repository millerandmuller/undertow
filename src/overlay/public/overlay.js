import {
  GAUGE_HUB,
  arcPath,
  createWarningMemory,
  labelAnchor,
  isStale,
  paceAngle,
  stepDots,
  tickEndpoints,
  updateWarningElement,
} from './gauge.js';

const card = document.querySelector('#card');
const pace = document.querySelector('#pace');
const metrics = document.querySelector('#metrics');
const reason = document.querySelector('#reason');
const mode = document.querySelector('#mode');
const badge = document.querySelector('#badge');
const warning = document.querySelector('#warning');
const over = document.querySelector('#over');
const needle = document.querySelector('#needle');
const setpointMark = document.querySelector('#setpoint');
const setpointLabel = document.querySelector('#setpoint-label');
const arc = document.querySelector('#arc');
const steps = document.querySelector('#steps');
const rate = document.querySelector('#rate');
const rateFill = document.querySelector('#rate-fill');
const rateLabel = document.querySelector('#rate-label');
const params = new URLSearchParams(location.search);
const requestedScale = Number(params.get('scale') ?? '1');
const scale = Number.isFinite(requestedScale)
  ? Math.min(2.5, Math.max(0.5, requestedScale))
  : 1;
document.documentElement.style.setProperty('--scale', String(scale));

let latest = null;
let lastSignalAt = Date.now();
let connectionLost = false;
const warningMemory = createWarningMemory();

function setTick(value, setpoint) {
  const points = tickEndpoints(value, setpoint);
  setpointMark.setAttribute('x1', String(points.inner.x));
  setpointMark.setAttribute('y1', String(points.inner.y));
  setpointMark.setAttribute('x2', String(points.outer.x));
  setpointMark.setAttribute('y2', String(points.outer.y));
  const anchor = labelAnchor(value, setpoint);
  setpointLabel.setAttribute('x', String(anchor.x));
  setpointLabel.setAttribute('y', String(anchor.y));
  setpointLabel.setAttribute('text-anchor', anchor.x < GAUGE_HUB.x ? 'end' : 'start');
}

function renderSteps(step, count) {
  steps.replaceChildren(...stepDots(step, count).map((active) => {
    const dot = document.createElement('span');
    dot.className = active ? 'dot active' : 'dot';
    return dot;
  }));
}

function render(state) {
  latest = state;
  const paceValue = Number.isFinite(state.pace) ? Math.max(0, state.pace) : 0;
  const setpointValue = Number.isFinite(state.setpoint) ? Math.max(0, state.setpoint) : 0;
  const angle = paceAngle(paceValue, setpointValue);
  arc.setAttribute('d', arcPath());
  pace.textContent = paceValue.toFixed(1);
  metrics.textContent = `pace ${paceValue.toFixed(1)}/s` +
    `${state.paceSource === 'modeled' ? ' modeled' : ''}, ` +
    `setpoint ${setpointValue.toFixed(1)}/s, ` +
    `step ${state.step} of ${state.stepCount} ${state.stepLabel}`;
  reason.textContent = state.lastReason || 'waiting for chat';
  badge.textContent = state.badge ?? '';
  badge.classList.toggle('hidden', !state.badge);
  mode.textContent = state.mode === 'live'
    ? 'live'
    : state.mode === 'simulation' ? 'simulation' : 'dry run';
  const duplicateSimulationMode = state.mode === 'simulation' &&
    state.badge?.toUpperCase() === 'SIMULATION';
  mode.classList.toggle('hidden', duplicateSimulationMode);
  updateWarningElement(warning, state, Date.now(), warningMemory);
  over.classList.toggle('hidden', setpointValue <= 0 ||
    paceValue <= setpointValue * 2.5);
  needle.style.transform = `rotate(${90 - angle}deg)`;
  setTick(setpointValue, setpointValue);
  card.classList.toggle('simulation', state.mode === 'simulation');
  renderSteps(state.step, state.stepCount);
  if (state.ratelimitRemaining !== null && state.ratelimitLimit > 0) {
    rate.classList.remove('hidden');
    rateLabel.textContent = `${state.ratelimitRemaining} of ${state.ratelimitLimit}`;
    const percent = Math.min(100, Math.max(0,
      state.ratelimitRemaining / state.ratelimitLimit * 100));
    rateFill.style.width = `${percent}%`;
  } else {
    rate.classList.add('hidden');
  }
}

function showConnectionState() {
  const stale = isStale(Date.now(), lastSignalAt);
  if (latest?.mode === 'simulation' && latest.warning === null) {
    updateWarningElement(warning, latest, Date.now(), warningMemory);
  }
  card.classList.toggle('stale', stale || connectionLost);
  if (connectionLost || stale) reason.textContent = 'reconnecting';
  else if (latest) reason.textContent = latest.lastReason || 'waiting for chat';
}

const stream = new EventSource('/events');
stream.addEventListener('state', (event) => {
  lastSignalAt = Date.now();
  connectionLost = false;
  render(JSON.parse(event.data));
  showConnectionState();
});
stream.addEventListener('heartbeat', () => {
  lastSignalAt = Date.now();
  connectionLost = false;
  showConnectionState();
});
stream.onopen = () => {
  connectionLost = false;
  showConnectionState();
};
stream.onerror = () => {
  connectionLost = true;
  showConnectionState();
};
setInterval(showConnectionState, 500);
