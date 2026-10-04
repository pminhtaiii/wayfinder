import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaPath = resolve(root, 'apps/api/prisma/schema.prisma');
const migrationsPath = resolve(root, 'apps/api/prisma/migrations');
const migrationName = '20260929000000_supplier_identifiers';
const migrationPath = resolve(migrationsPath, migrationName, 'migration.sql');
const schema = readFileSync(schemaPath, 'utf8');

const columnRenames = [
  { model: 'Booking', table: 'bookings', from: 'duffelOrderId', to: 'supplierOrderId', type: 'String?' },
  {
    model: 'Booking',
    table: 'bookings',
    from: 'duffelCancellationQuoteId',
    to: 'supplierCancellationQuoteId',
    type: 'String?',
  },
  {
    model: 'Booking',
    table: 'bookings',
    from: 'lastDuffelSyncedAt',
    to: 'lastSupplierSyncedAt',
    type: 'DateTime?',
  },
  {
    model: 'Booking',
    table: 'bookings',
    from: 'nextDuffelSyncAt',
    to: 'nextSupplierSyncAt',
    type: 'DateTime?',
  },
  {
    model: 'BookingIntent',
    table: 'booking_intents',
    from: 'duffelOfferId',
    to: 'supplierOfferId',
    type: 'String',
  },
  {
    model: 'BookingIntentPassenger',
    table: 'booking_intent_passengers',
    from: 'duffelPassengerId',
    to: 'supplierPassengerId',
    type: 'String?',
  },
  {
    model: 'SeatSelection',
    table: 'seat_selections',
    from: 'duffelPassengerId',
    to: 'supplierPassengerId',
    type: 'String',
  },
  {
    model: 'BaggageSelection',
    table: 'baggage_selections',
    from: 'duffelPassengerId',
    to: 'supplierPassengerId',
    type: 'String',
  },
  {
    model: 'FlightOffer',
    table: 'flight_offers',
    from: 'duffelOfferId',
    to: 'supplierOfferId',
    type: 'String',
  },
  {
    model: 'ItineraryRevisionSegment',
    table: 'itinerary_revision_segments',
    from: 'duffelSegmentId',
    to: 'supplierSegmentId',
    type: 'String?',
  },
  {
    model: 'ChatHandoff',
    table: 'chat_handoffs',
    from: 'duffelOfferIdHash',
    to: 'supplierOfferIdHash',
    type: 'String',
  },
];

const indexRenames = [
  ['bookings_duffelOrderId_idx', 'bookings_supplierOrderId_idx'],
  [
    'bookings_status_nextUnflownDepartureAt_lastDuffelSyncedAt_idx',
    'bookings_status_nextUnflownDepartureAt_lastSupplierSyncedAt_idx',
  ],
  [
    'booking_intent_passengers_intentId_duffelPassengerId_idx',
    'booking_intent_passengers_intentId_supplierPassengerId_idx',
  ],
  ['flight_offers_searchHash_duffelOfferId_key', 'flight_offers_searchHash_supplierOfferId_key'],
  [
    'itinerary_revision_segments_duffelSegmentId_idx',
    'itinerary_revision_segments_supplierSegmentId_idx',
  ],
];

function modelBlock(modelName) {
  const match = schema.match(new RegExp(`^model ${modelName} \\{([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(match, `Prisma model ${modelName} exists`);
  return match[1];
}

test('Prisma fields use neutral names without changing nullability or index definitions', () => {
  for (const rename of columnRenames) {
    const model = modelBlock(rename.model);
    const field = model.match(new RegExp(`^\\s*${rename.to}\\s+([^\\s]+)([^\\r\\n]*)$`, 'm'));
    assert.ok(field, `${rename.model}.${rename.to} exists`);
    assert.equal(field[1], rename.type, `${rename.model}.${rename.to} keeps its nullability`);
    assert.doesNotMatch(field[2], /@map\(/, `${rename.model}.${rename.to} has no legacy column alias`);
    assert.doesNotMatch(model, new RegExp(`^\\s*${rename.from}\\s+`, 'm'));
  }

  assert.match(modelBlock('Booking'), /@@index\(\[supplierOrderId\]\)/);
  assert.match(
    modelBlock('Booking'),
    /@@index\(\[status, nextUnflownDepartureAt, lastSupplierSyncedAt\]\)/,
  );
  assert.match(
    modelBlock('BookingIntentPassenger'),
    /@@index\(\[intentId, supplierPassengerId\]\)/,
  );
  assert.match(modelBlock('FlightOffer'), /@@unique\(\[searchHash, supplierOfferId\]\)/);
  assert.match(modelBlock('ItineraryRevisionSegment'), /@@index\(\[supplierSegmentId\]\)/);
});

test('forward migration renames all eleven columns and five dependent indexes in place', () => {
  assert.ok(existsSync(migrationPath), `forward migration exists at ${migrationPath}`);
  const migration = readFileSync(migrationPath, 'utf8');

  for (const rename of columnRenames) {
    const statement = `ALTER TABLE "${rename.table}" RENAME COLUMN "${rename.from}" TO "${rename.to}";`;
    assert.ok(migration.includes(statement), statement);
  }
  assert.equal([...migration.matchAll(/ALTER TABLE "[^"]+" RENAME COLUMN/g)].length, 11);

  for (const [from, to] of indexRenames) {
    const statement = `ALTER INDEX "${from}" RENAME TO "${to}";`;
    assert.ok(migration.includes(statement), statement);
  }
  assert.equal([...migration.matchAll(/ALTER INDEX "[^"]+" RENAME TO/g)].length, 5);
  assert.doesNotMatch(migration, /\b(?:ADD|DROP)\s+COLUMN\b|\bALTER\s+COLUMN\b|\b(?:CREATE|DROP)\s+INDEX\b/i);

  const targetSyncIndex = indexRenames[1][1];
  assert.equal(Buffer.byteLength(targetSyncIndex, 'ascii'), 63);
});

test('Duffel webhook schema and historical migration chain remain outside the rename', () => {
  const webhook = modelBlock('DuffelWebhookEvent');
  assert.match(webhook, /^\s*duffelOrderId\s+String\?/m);
  assert.match(webhook, /@@index\(\[duffelOrderId, createdAt\(sort: Desc\)\]\)/);
  assert.match(webhook, /@@map\("duffel_webhook_events"\)/);
  assert.match(schema, /^enum DuffelWebhookEventStatus\s*\{/m);

  assert.ok(existsSync(migrationPath), `forward migration exists at ${migrationPath}`);
  const migration = readFileSync(migrationPath, 'utf8');
  assert.doesNotMatch(migration, /duffel_webhook_events|duffelOrderId_createdAt/);

  // Human approval (2026-10-03): exclude Prisma metadata and enumerate only migrations; all other assertions stay unchanged.
  const migrationDirectories = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // Human approval (2026-10-03): check the immediate predecessor so later migrations can be appended.
  const migrationIndex = migrationDirectories.indexOf(migrationName);
  assert.ok(migrationIndex > 0, `${migrationName} appears after a predecessor`);
  assert.equal(
    migrationDirectories[migrationIndex - 1],
    '20260915000000_booking_projection_versions',
  );
});
