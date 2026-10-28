import { paceAngle, stepDots } from './gauge.js';

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
const steps = document.querySelector('#steps');
const rate = document.querySelector('#rate');
const rateFill = document.querySelector('#rate-fill');
const params = new URLSearchParams(location.search);
const requestedScale = Number(params.get('scale') ?? '1');
const scale = Number.isFinite(requestedScale)
  ? Math.min(2.5, Math.max(0.5, requestedScale))
  : 1;
document.documentElement.style.setProperty('--scale', String(scale));

let latest = null;
let lastSignalAt = Date.now();
let connectionLost = false;

function setPolarLine(element, angle, innerRadius, outerRadius) {
  const radians = angle * Math.PI / 180;
  element.setAttribute('x1', String(200 + Math.cos(radians) * innerRadius));
  element.setAttribute('y1', String(150 - Math.sin(radians) * innerRadius));
  element.setAttribute('x2', String(200 + Math.cos(radians) * outerRadius));
  element.setAttribute('y2', String(150 - Math.sin(radians) * outerRadius));
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
  const setpointAngle = paceAngle(setpointValue, setpointValue);
  pace.textContent = paceValue.toFixed(1);
  metrics.textContent = `pace ${paceValue.toFixed(1)}/s` +
    `${state.paceSource === 'modeled' ? ' modeled' : ''}, ` +
    `setpoint ${setpointValue.toFixed(1)}/s, ` +
    `step ${state.step} of ${state.stepCount} ${state.stepLabel}`;
  reason.textContent = state.lastReason || 'waiting for chat';
  mode.textContent = state.mode === 'simulation'
    ? 'simulation'
    : state.mode === 'live' ? 'live' : 'dry run';
  badge.textContent = state.badge ?? '';
  badge.classList.toggle('hidden', !state.badge);
  warning.textContent = state.warning === 'gift' ? 'gift wave' : 'raid';
  warning.classList.toggle('hidden', !state.warning);
  over.classList.toggle('hidden', setpointValue <= 0 ||
    paceValue <= setpointValue * 2.5);
  needle.style.transform = `rotate(${90 - angle}deg)`;
  setPolarLine(setpointMark, setpointAngle, 128, 145);
  card.classList.toggle('simulation', state.mode === 'simulation');
  renderSteps(state.step, state.stepCount);
  if (state.ratelimitRemaining !== null && state.ratelimitLimit > 0) {
    rate.classList.remove('hidden');
    const percent = Math.min(100, Math.max(0,
      state.ratelimitRemaining / state.ratelimitLimit * 100));
    rateFill.style.width = `${percent}%`;
  } else {
    rate.classList.add('hidden');
  }
}

function showConnectionState() {
  const stale = Date.now() - lastSignalAt > 5000;
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
  lastSignalAt = Date.now();
  connectionLost = false;
  showConnectionState();
};
stream.onerror = () => {
  connectionLost = true;
  showConnectionState();
};
setInterval(showConnectionState, 500);
