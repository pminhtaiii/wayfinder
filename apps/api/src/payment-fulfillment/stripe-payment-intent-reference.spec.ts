import { hasStripePaymentIntentId } from './stripe-payment-intent-reference';

describe('hasStripePaymentIntentId', () => {
  it('rejects a null Stripe payment intent ID', () => {
    expect(hasStripePaymentIntentId({ stripePaymentIntentId: null })).toBe(false);
  });

  it('rejects an empty Stripe payment intent ID', () => {
    expect(hasStripePaymentIntentId({ stripePaymentIntentId: '' })).toBe(false);
  });

  it('accepts a non-empty Stripe payment intent ID', () => {
    expect(hasStripePaymentIntentId({ stripePaymentIntentId: 'pi_123' })).toBe(true);
  });
});