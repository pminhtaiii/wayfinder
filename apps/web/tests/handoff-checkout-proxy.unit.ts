import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeHandoffCheckoutPayload } from '../lib/handoffCheckoutPayload';
import { safeHandoffCheckoutOrigin, safeHandoffTraceHeaders } from '../lib/handoffCheckoutRequest';

test('accepts only canonical readiness client fields', () => {
  assert.equal(
    isSafeHandoffCheckoutPayload(
      {
        passengers: [
          { offerPassengerId: 'pas_001', passengerType: 'ADULT', source: { type: 'inline' } },
        ],
      },
      '/api/bookings/intents/readiness',
    ),
    true,
  );
  assert.equal(
    isSafeHandoffCheckoutPayload(
      { handoffToken: 'credential', passengers: [] },
      '/api/bookings/intents/readiness',
    ),
    false,
  );
});

test('rejects nested credential and provider fields from checkout client payloads', () => {
  assert.equal(
    isSafeHandoffCheckoutPayload(
      { passengers: [{ source: { handoffToken: 'credential' } }] },
      '/api/bookings/intents',
    ),
    false,
  );
  assert.equal(
    isSafeHandoffCheckoutPayload(
      { passengers: [], readinessScope: 'DOMESTIC', duffelOfferId: 'provider-id' },
      '/api/bookings/intents',
    ),
    false,
  );
});

test('rejects provider identity keys at checkout roots and nested legacy Duffel identities', (): void => {
  for (const identityKey of ['duffelOfferId', 'supplierOfferId']) {
    assert.equal(
      isSafeHandoffCheckoutPayload(
        { passengers: [], [identityKey]: 'injected-provider-id' },
        '/api/bookings/intents/readiness',
      ),
      false,
    );
    assert.equal(
      isSafeHandoffCheckoutPayload(
        { passengers: [], readinessScope: 'DOMESTIC', [identityKey]: 'injected-provider-id' },
        '/api/bookings/intents',
      ),
      false,
    );
  }

  assert.equal(
    isSafeHandoffCheckoutPayload(
      { passengers: [{ source: { duffelOfferId: 'injected-provider-id' } }] },
      '/api/bookings/intents',
    ),
    false,
  );
  assert.equal(isSafeHandoffCheckoutPayload({ passengers: [] }, '/api/bookings/intents/readiness'), true);
  assert.equal(
    isSafeHandoffCheckoutPayload(
      { passengers: [], readinessScope: 'DOMESTIC' },
      '/api/bookings/intents',
    ),
    true,
  );
});

test('trusts only configured same-origin checkout requests', () => {
  const spoofedRequest = new Request('https://attacker.example/api/checkout/handoff/intents', {
    headers: { Origin: 'https://attacker.example' },
  });

  assert.equal(safeHandoffCheckoutOrigin(spoofedRequest, 'https://booking.example'), false);
});

test('forwards only opaque trace and correlation identifiers', () => {
  const headers = new Headers({
    'x-trace-id': `chat_${'a'.repeat(32)}`,
    'x-correlation-id': 'customer@example.com',
  });

  assert.deepEqual(safeHandoffTraceHeaders(headers), {
    'X-Trace-Id': `chat_${'a'.repeat(32)}`,
  });
});
