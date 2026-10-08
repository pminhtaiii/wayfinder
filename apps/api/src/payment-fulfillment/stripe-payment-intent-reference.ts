export function hasStripePaymentIntentId<T extends { stripePaymentIntentId: string | null }>(
  payment: T,
): payment is T & { stripePaymentIntentId: string } {
  return typeof payment.stripePaymentIntentId === 'string' &&
    payment.stripePaymentIntentId.length > 0;
}