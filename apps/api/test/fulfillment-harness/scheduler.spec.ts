import { VirtualFulfillmentRecoveryScheduler } from './scheduler';

describe('fulfillment recovery scheduler', () => {
  it('runs only jobs due by the advanced virtual time in due-time order', async () => {
    const scheduler = new VirtualFulfillmentRecoveryScheduler(
      new Date('2026-10-07T00:00:00.000Z'),
    );
    const executed: string[] = [];

    scheduler.register('later', new Date('2026-10-07T00:00:03.000Z'), async () => {
      executed.push('later');
    });
    scheduler.register('first', new Date('2026-10-07T00:00:01.000Z'), async () => {
      executed.push('first');
    });

    await expect(scheduler.advance(2_000, 10)).resolves.toEqual({
      executedJobIds: ['first'],
      nextDueAt: new Date('2026-10-07T00:00:03.000Z'),
      exceededBudget: false,
    });
    expect(executed).toEqual(['first']);
  });
});

  it('limits each advance to its explicit job budget', async () => {
    const scheduler = new VirtualFulfillmentRecoveryScheduler(
      new Date('2026-10-07T00:00:00.000Z'),
    );
    const executed: string[] = [];
    for (const jobId of ['first', 'second', 'third']) {
      scheduler.register(jobId, new Date('2026-10-07T00:00:01.000Z'), async () => {
        executed.push(jobId);
      });
    }

    await expect(scheduler.advance(1_000, 2)).resolves.toEqual({
      executedJobIds: ['first', 'second'],
      nextDueAt: new Date('2026-10-07T00:00:01.000Z'),
      exceededBudget: true,
    });
    expect(executed).toEqual(['first', 'second']);
  });

it('orders equal due times by job ID', async () => {
  const scheduler = new VirtualFulfillmentRecoveryScheduler(
    new Date('2026-10-07T00:00:00.000Z'),
  );
  const executed: string[] = [];
  for (const jobId of ['charlie', 'alpha', 'bravo']) {
    scheduler.register(jobId, new Date('2026-10-07T00:00:01.000Z'), async () => {
      executed.push(jobId);
    });
  }

  await scheduler.advance(1_000, 3);
  expect(executed).toEqual(['alpha', 'bravo', 'charlie']);
});

it('cancels a registered job before it becomes due', async () => {
  const scheduler = new VirtualFulfillmentRecoveryScheduler(
    new Date('2026-10-07T00:00:00.000Z'),
  );
  const run = jest.fn(async (): Promise<void> => undefined);
  scheduler.register('cancel-me', new Date('2026-10-07T00:00:01.000Z'), run);
  scheduler.cancel('cancel-me');

  await expect(scheduler.advance(1_000, 1)).resolves.toEqual({
    executedJobIds: [],
    nextDueAt: null,
    exceededBudget: false,
  });
  expect(run).not.toHaveBeenCalled();
});

it('rejects a provider-purpose pair that cannot produce its outcome', async () => {
  const { assertSupportedFaultSelection } = await import('./scenarios');

  expect(() =>
    assertSupportedFaultSelection({
      provider: 'STRIPE',
      purpose: 'PAYMENT_INTENT_CREATE',
      bookingIntentId: 'scenario-pair-test',
      outcome: 'ZERO_CANDIDATES',
    }),
  ).toThrow('Unsupported fulfillment fault scenario');
});
