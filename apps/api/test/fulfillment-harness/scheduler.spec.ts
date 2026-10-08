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
