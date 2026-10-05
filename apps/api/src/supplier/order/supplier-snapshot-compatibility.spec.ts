import {
  mapDuffelOrderToSnapshots,
  normalizeDuffelOrder,
} from './order-snapshot.normalizer';

describe('supplier snapshot compatibility', () => {
  it('writes neutral segment IDs while preserving order and identity', () => {
    const order = {
      slices: [
        {
          segments: [
            { id: 'seg_1', departing_at: '2026-10-01T08:00:00Z' },
            { id: 'seg_2', departing_at: '2026-10-01T10:00:00Z' },
          ],
        },
      ],
    };

    const snapshot = mapDuffelOrderToSnapshots(order).flightSnapshot;
    const normalized = normalizeDuffelOrder(order);

    expect(snapshot.segments.map((segment) => segment.supplierSegmentId)).toEqual([
      'seg_1',
      'seg_2',
    ]);
    expect(snapshot.segments[0]).not.toHaveProperty('duffelSegmentId');
    expect(normalized.map((segment) => segment.supplierSegmentId)).toEqual(['seg_1', 'seg_2']);
    expect(normalized.map(({ sliceOrder, segmentOrder, globalOrder }) => [
      sliceOrder,
      segmentOrder,
      globalOrder,
    ])).toEqual([
      [0, 0, 0],
      [0, 1, 1],
    ]);
    expect(normalized[0]).not.toHaveProperty('duffelSegmentId');
  });
});
