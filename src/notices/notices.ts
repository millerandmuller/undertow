import type { LadderStep, ProfileConfig } from '../config.ts';
import type { ControllerAction } from '../controller/controller.ts';

export type Notice = {
  kind: 'step_up' | 'step_down' | 'warning' | 'restore';
  message: string;
  overlayText: string;
};

function bounded(notice: Notice): Notice {
  if (notice.message.length > 500) {
    throw new Error('Notice message exceeds Twitch chat limit of 500 characters');
  }
  return notice;
}

function releaseCondition(config: ProfileConfig): string {
  const release = config.setpoint_msgs_per_s * config.release_ratio;
  return `under ${release} msgs/s for ${config.release_hold_s} s`;
}

export function stepUpNotice(
  step: LadderStep,
  stepNumber: number,
  pace: number,
  config: ProfileConfig,
): Notice {
  const message = `${step.label}: chat hit ${pace} msgs/s. Back to normal when it drops ` +
    `${releaseCondition(config)}.`;
  return bounded({
    kind: 'step_up',
    message,
    overlayText: `pace ${pace}/s, setpoint ${config.setpoint_msgs_per_s}/s, ` +
      `step ${stepNumber} of ${config.ladder.length}`,
  });
}

export function warningNotice(
  reason: 'gift' | 'raid',
  pace: number,
  stepNumber: number,
  config: ProfileConfig,
): Notice {
  const arrival = reason === 'raid' ? 'a raid is landing' : 'a gift wave is landing';
  return bounded({
    kind: 'warning',
    message: `Followers-only 10 min for a moment: ${arrival}. Releasing as soon as it settles.`,
    overlayText: `pace ${pace}/s, setpoint ${config.setpoint_msgs_per_s}/s, ` +
      `step ${stepNumber} of ${config.ladder.length}`,
  });
}

export function stepDownNotice(
  step: LadderStep,
  stepNumber: number,
  pace: number,
  config: ProfileConfig,
): Notice {
  const message = `Easing to ${step.label.toLowerCase()}: chat is at ${pace} msgs/s. ` +
    `Next step down when it stays ${releaseCondition(config)}.`;
  return bounded({
    kind: 'step_down',
    message,
    overlayText: `pace ${pace}/s, setpoint ${config.setpoint_msgs_per_s}/s, ` +
      `step ${stepNumber} of ${config.ladder.length}`,
  });
}

export function restoreNotice(
  pace: number,
  stepNumber: number,
  config: ProfileConfig,
): Notice {
  return bounded({
    kind: 'restore',
    message: 'Chat is back to normal. Settings restored.',
    overlayText: `pace ${pace}/s, setpoint ${config.setpoint_msgs_per_s}/s, ` +
      `step ${stepNumber} of ${config.ladder.length}`,
  });
}

export function actionNotice(
  action: ControllerAction,
  config: ProfileConfig,
  pace: number,
): Notice | null {
  if (action.type === 'step_up') {
    const step = config.ladder[action.step - 1];
    return step ? stepUpNotice(step, action.step, pace, config) : null;
  }
  if (action.type === 'step_down') {
    const step = config.ladder[action.step - 1];
    return step ? stepDownNotice(step, action.step, pace, config) : null;
  }
  if (action.type === 'restore') return restoreNotice(pace, 0, config);
  return null;
}
