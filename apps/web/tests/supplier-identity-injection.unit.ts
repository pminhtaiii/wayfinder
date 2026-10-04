import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeHandoffCheckoutPayload } from '../lib/handoffCheckoutPayload';

const checkoutPaths: Array<
  '/api/bookings/intents/readiness' | '/api/bookings/intents'
> = [
  '/api/bookings/intents/readiness',
  '/api/bookings/intents',
];

test('rejects both provider identity spellings at every checkout payload depth', (): void => {
  for (const pathname of checkoutPaths) {
    for (const identityKey of ['duffelOfferId', 'supplierOfferId']) {
      assert.equal(
        isSafeHandoffCheckoutPayload(
          { passengers: [], [identityKey]: 'injected' },
          pathname,
        ),
        false,
      );
      assert.equal(
        isSafeHandoffCheckoutPayload(
          { passengers: [{ [identityKey]: 'injected' }] },
          pathname,
        ),
        false,
      );
      assert.equal(
        isSafeHandoffCheckoutPayload(
          { passengers: [{ source: [{ details: { [identityKey]: 'injected' } }] }] },
          pathname,
        ),
        false,
      );
    }
  }
});

test('accepts canonical checkout payloads at both endpoint boundaries', (): void => {
  assert.equal(
    isSafeHandoffCheckoutPayload({ passengers: [] }, '/api/bookings/intents/readiness'),
    true,
  );
  assert.equal(
    isSafeHandoffCheckoutPayload(
      { passengers: [], readinessScope: 'DOMESTIC' },
      '/api/bookings/intents',
    ),
    true,
  );
});
