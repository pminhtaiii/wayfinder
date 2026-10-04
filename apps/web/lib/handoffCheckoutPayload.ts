const FORBIDDEN_KEYS = new Set([
  'handoffToken',
  'flightOfferId',
  'chatSessionId',
  'duffelOfferId',
  'supplierOfferId',
  'offerId',
]);

export function isSafeHandoffCheckoutPayload(
  value: unknown,
  pathname: '/api/bookings/intents/readiness' | '/api/bookings/intents',
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const allowed =
    pathname === '/api/bookings/intents/readiness'
      ? new Set(['passengers'])
      : new Set(['passengers', 'readinessScope']);
  return Object.keys(value).every((key) => allowed.has(key)) && !containsForbiddenKey(value);
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(child),
  );
}
