import {
  labelAnchor,
  pointOnArc,
  tickEndpoints,
} from '../src/overlay/public/gauge.js';

const setpoint = 2;
const values = [0, setpoint, setpoint * 2.5];
const point = ({ x, y }) => `(${x.toFixed(1)}, ${y.toFixed(1)})`;

for (const value of values) {
  const needle = pointOnArc(value, setpoint);
  const tick = tickEndpoints(setpoint, setpoint);
  const label = labelAnchor(setpoint, setpoint);
  console.log(
    `pace ${value.toFixed(1)}: needle ${point(needle)}; ` +
    `setpoint tick ${point(tick.inner)} to ${point(tick.outer)}; ` +
    `label ${point(label)}`,
  );
}
