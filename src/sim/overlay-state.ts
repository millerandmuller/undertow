import type { OverlayOptions } from '../overlay/server.ts';
import { labelRateText } from './response-model.ts';

export function simulationOverlayOptions(modeled: boolean): OverlayOptions {
  return {
    mapState(state) {
      return {
        pace: state.pace,
        setpoint: state.setpoint,
        step: state.step,
        mode: 'simulation',
        stepLabel: state.stepLabel,
        stepCount: state.stepCount,
        warning: state.warning,
        warningHoldSeconds: state.warningHoldSeconds,
        ratelimitRemaining: state.ratelimitRemaining,
        ratelimitLimit: state.ratelimitLimit,
        paceSource: modeled ? 'modeled' : 'measured',
        badge: 'SIMULATION',
        lastReason: labelRateText(state.lastReason, modeled ? 'modeled' : 'recorded'),
      };
    },
  };
}

