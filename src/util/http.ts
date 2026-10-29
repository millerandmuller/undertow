export const REQUEST_TIMEOUT_MS = 10_000;

export function requestSignal(milliseconds = REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}
