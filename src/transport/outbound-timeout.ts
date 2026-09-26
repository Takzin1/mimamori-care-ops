export const DEFAULT_OUTBOUND_REQUEST_TIMEOUT_MS =
  10_000;

export const MAX_OUTBOUND_REQUEST_TIMEOUT_MS =
  60_000;

export function normalizeOutboundRequestTimeoutMs(
  value:
    | number
    | undefined,
): number {
  const timeout =
    value ??
    DEFAULT_OUTBOUND_REQUEST_TIMEOUT_MS;

  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout >
      MAX_OUTBOUND_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `outbound request timeout must be an integer between 1 and ${MAX_OUTBOUND_REQUEST_TIMEOUT_MS} ms`,
    );
  }

  return timeout;
}

export function outboundRequestSignal(
  timeoutMs: number,
  upstream?: AbortSignal | null,
): AbortSignal {
  const timeout =
    AbortSignal.timeout(timeoutMs);

  return upstream
    ? AbortSignal.any([
        upstream,
        timeout,
      ])
    : timeout;
}
