export type ReportStep = {
  t: string;
  action: string;
  reading: string;
};

export type ReportProposal = {
  setpoint: number;
  dwell_s: number;
  release_hold_s: number;
};

export type ReportCard = {
  cause: string;
  steps: ReportStep[];
  proposed: ReportProposal;
  risk: string;
};

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cause', 'steps', 'proposed', 'risk'],
  properties: {
    cause: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['t', 'action', 'reading'],
        properties: {
          t: { type: 'string' },
          action: { type: 'string' },
          reading: { type: 'string' },
        },
      },
    },
    proposed: {
      type: 'object',
      additionalProperties: false,
      required: ['setpoint', 'dwell_s', 'release_hold_s'],
      properties: {
        setpoint: { type: 'number' },
        dwell_s: { type: 'number' },
        release_hold_s: { type: 'number' },
      },
    },
    risk: { type: 'string' },
  },
} as const;

export function parseReportCard(value: unknown): ReportCard {
  if (!isObject(value) || !hasKeys(value, ['cause', 'steps', 'proposed', 'risk'])) {
    throw new Error('report must contain cause, steps, proposed, and risk only');
  }
  if (!isText(value.cause) || !isText(value.risk) || !Array.isArray(value.steps)) {
    throw new Error('report cause, risk, and steps have invalid types');
  }
  const steps = value.steps.map(parseStep);
  if (!isObject(value.proposed) || !hasKeys(value.proposed, [
    'setpoint', 'dwell_s', 'release_hold_s',
  ])) {
    throw new Error('report proposed values have invalid fields');
  }
  const { setpoint, dwell_s: dwell, release_hold_s: release } = value.proposed;
  if (![setpoint, dwell, release].every(isNumber)) {
    throw new Error('report proposed values must be finite numbers');
  }
  return {
    cause: value.cause,
    steps,
    proposed: { setpoint, dwell_s: dwell, release_hold_s: release },
    risk: value.risk,
  };
}

function parseStep(value: unknown): ReportStep {
  if (!isObject(value) || !hasKeys(value, ['t', 'action', 'reading']) ||
    !isText(value.t) || !isText(value.action) || !isText(value.reading)) {
    throw new Error('report steps must contain t, action, and reading strings only');
  }
  return { t: value.t, action: value.action, reading: value.reading };
}

function hasKeys(value: Record<string, unknown>, required: string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).length === required.length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
