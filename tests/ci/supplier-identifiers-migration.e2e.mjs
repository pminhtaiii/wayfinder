import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationName = '20260929000000_supplier_identifiers';
const predecessorName = '20260915000000_booking_projection_versions';
const targetDatabases = ['feature029_slice62_fresh', 'feature029_slice62_upgrade'];
const migrationRoot = resolve(root, 'apps/api/prisma/migrations');
const currentSchema = resolve(root, 'apps/api/prisma/schema.prisma');
const requiredIndexes = [
  {
    name: 'bookings_supplierOrderId_idx',
    table: 'bookings',
    columns: ['supplierOrderId'],
    legacyColumns: ['duffelOrderId'],
    unique: false,
  },
  {
    name: 'bookings_status_nextUnflownDepartureAt_lastSupplierSyncedAt_idx',
    table: 'bookings',
    columns: ['status', 'nextUnflownDepartureAt', 'lastSupplierSyncedAt'],
    legacyColumns: ['status', 'nextUnflownDepartureAt', 'lastDuffelSyncedAt'],
    unique: false,
  },
  {
    name: 'booking_intent_passengers_intentId_supplierPassengerId_idx',
    table: 'booking_intent_passengers',
    columns: ['intentId', 'supplierPassengerId'],
    legacyColumns: ['intentId', 'duffelPassengerId'],
    unique: false,
  },
  {
    name: 'flight_offers_searchHash_supplierOfferId_key',
    table: 'flight_offers',
    columns: ['searchHash', 'supplierOfferId'],
    legacyColumns: ['searchHash', 'duffelOfferId'],
    unique: true,
  },
  {
    name: 'itinerary_revision_segments_supplierSegmentId_idx',
    table: 'itinerary_revision_segments',
    columns: ['supplierSegmentId'],
    legacyColumns: ['duffelSegmentId'],
    unique: false,
  },
];
const legacyIndexNames = [
  'bookings_duffelOrderId_idx',
  'bookings_status_nextUnflownDepartureAt_lastDuffelSyncedAt_idx',
  'booking_intent_passengers_intentId_duffelPassengerId_idx',
  'flight_offers_searchHash_duffelOfferId_key',
  'itinerary_revision_segments_duffelSegmentId_idx',
];
const webhookIndexName = 'duffel_webhook_events_duffelOrderId_createdAt_idx';
const tables = [
  {
    name: 'bookings',
    identities: ['id', 'userId', 'bookingIntentId'],
    fields: [
      ['duffelOrderId', 'supplierOrderId'],
      ['duffelCancellationQuoteId', 'supplierCancellationQuoteId'],
      ['lastDuffelSyncedAt', 'lastSupplierSyncedAt'],
      ['nextDuffelSyncAt', 'nextSupplierSyncAt'],
    ],
  },
  {
    name: 'booking_intents',
    identities: ['id', 'userId', 'flightOfferId'],
    fields: [['duffelOfferId', 'supplierOfferId']],
  },
  {
    name: 'booking_intent_passengers',
    identities: ['id', 'intentId'],
    fields: [['duffelPassengerId', 'supplierPassengerId']],
  },
  {
    name: 'seat_selections',
    identities: ['id', 'ancillarySelectionId', 'intentPassengerId'],
    fields: [['duffelPassengerId', 'supplierPassengerId']],
  },
  {
    name: 'baggage_selections',
    identities: ['id', 'ancillarySelectionId', 'intentPassengerId'],
    fields: [['duffelPassengerId', 'supplierPassengerId']],
  },
  {
    name: 'flight_offers',
    identities: ['id', 'searchHash'],
    fields: [['duffelOfferId', 'supplierOfferId']],
  },
  {
    name: 'itinerary_revision_segments',
    identities: ['id', 'revisionId', 'globalOrder'],
    fields: [['duffelSegmentId', 'supplierSegmentId']],
  },
  {
    name: 'chat_handoffs',
    identities: ['id', 'userId', 'chatSessionId', 'flightOfferId'],
    fields: [['duffelOfferIdHash', 'supplierOfferIdHash']],
  },
];
const columnExpectations = [
  { table: 'bookings', old: 'duffelOrderId', current: 'supplierOrderId', nullable: true },
  {
    table: 'bookings',
    old: 'duffelCancellationQuoteId',
    current: 'supplierCancellationQuoteId',
    nullable: true,
  },
  { table: 'bookings', old: 'lastDuffelSyncedAt', current: 'lastSupplierSyncedAt', nullable: true },
  { table: 'bookings', old: 'nextDuffelSyncAt', current: 'nextSupplierSyncAt', nullable: true },
  {
    table: 'booking_intents',
    old: 'duffelOfferId',
    current: 'supplierOfferId',
    nullable: false,
  },
  {
    table: 'booking_intent_passengers',
    old: 'duffelPassengerId',
    current: 'supplierPassengerId',
    nullable: true,
  },
  { table: 'seat_selections', old: 'duffelPassengerId', current: 'supplierPassengerId', nullable: false },
  {
    table: 'baggage_selections',
    old: 'duffelPassengerId',
    current: 'supplierPassengerId',
    nullable: false,
  },
  { table: 'flight_offers', old: 'duffelOfferId', current: 'supplierOfferId', nullable: false },
  {
    table: 'itinerary_revision_segments',
    old: 'duffelSegmentId',
    current: 'supplierSegmentId',
    nullable: true,
  },
  {
    table: 'chat_handoffs',
    old: 'duffelOfferIdHash',
    current: 'supplierOfferIdHash',
    nullable: false,
  },
];
const requireFromHarness = createRequire(import.meta.url);

export function getPreflightSummary(adminDatabaseUrl) {
  let parsed;
  try {
    parsed = new URL(adminDatabaseUrl);
  } catch {
    throw new Error('T054 admin database URL must be a valid PostgreSQL URL.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('T054 admin database URL must use a loopback host.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('T054 admin database URL must use PostgreSQL.');
  }
  if (parsed.port && parsed.port !== '5432') {
    throw new Error('T054 admin database URL must use the local PostgreSQL port 5432.');
  }
  if (parsed.pathname !== '/postgres' || parsed.hash) {
    throw new Error('T054 admin database URL must target the postgres admin database.');
  }
  if ([...parsed.searchParams.entries()].some(([key, value]) => key !== 'schema' || value !== 'public')) {
    throw new Error('T054 admin database URL only accepts the Prisma schema query option.');
  }

  return { adminDatabase: 'postgres', targetDatabases: [...targetDatabases] };
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function adminUrlForTarget(adminUrl, databaseName) {
  ensure(targetDatabases.includes(databaseName), 'Refusing an unapproved T054 database name.');
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  return target.toString();
}

function networkGuardPath() {
  const guard = resolve(root, 'tests/ci/node-network-guard.cjs');
  ensure(existsSync(guard), 'The repository loopback network guard is missing.');
  return guard;
}

function guardedNodeOptions(guard) {
  const normalized = guard.replaceAll('\\', '/');
  return [process.env.NODE_OPTIONS, `--require="${normalized}"`].filter(Boolean).join(' ');
}

function sanitizeOutput(value) {
  return value.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, 'postgresql://[credentials-redacted]@');
}

function prismaCliPath() {
  const path = requireFromHarness.resolve('prisma/build/index.js');
  ensure(existsSync(path), 'The installed Prisma CLI binary is missing.');
  return path;
}

function runPrismaCommand(command, databaseName, databaseUrl, schemaPath, guard) {
  ensure(targetDatabases.includes(databaseName), 'Refusing to run Prisma against an unapproved database.');
  const parsed = new URL(databaseUrl);
  ensure(parsed.pathname === `/${databaseName}`, 'Prisma database URL does not match its fixed target name.');
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_OPTIONS: guardedNodeOptions(guard),
  };
  delete environment.T054_ADMIN_DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    [prismaCliPath(), 'migrate', command, '--schema', schemaPath],
    { cwd: root, env: environment, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );
  const output = sanitizeOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) {
    const reason = result.error
      ? `process could not start (${result.error.code ?? 'unknown error code'})`
      : `exit status ${String(result.status)}`;
    throw new Error(`Prisma migrate ${command} failed for ${databaseName} (${reason}).\n${output}`);
  }
  if (command === 'status' && !/database schema is up to date/i.test(output)) {
    throw new Error(`Prisma migrate status did not report a clean database for ${databaseName}.\n${output}`);
  }
  return output;
}

function previousMigrationWorkspace() {
  const dirs = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const targetIndex = dirs.indexOf(migrationName);
  ensure(targetIndex > 0, `Migration ${migrationName} is missing from the current chain.`);
  ensure(dirs[targetIndex - 1] === predecessorName, `Expected ${predecessorName} immediately before ${migrationName}.`);

  const workspace = mkdtempSync(join(root, '.t054-prisma-chain-'));
  const workspaceReal = realpathSync(workspace);
  const rootReal = realpathSync(root);
  ensure(
    dirname(workspaceReal) === rootReal && basename(workspaceReal).startsWith('.t054-prisma-chain-'),
    'Temporary migration workspace resolved outside its verified root.',
  );
  ensure(!lstatSync(workspace).isSymbolicLink(), 'Temporary migration workspace cannot be a symbolic link.');

  const oldPrisma = join(workspaceReal, 'prisma');
  const oldMigrations = join(oldPrisma, 'migrations');
  const copiedDirs = dirs.slice(0, targetIndex);
  const workspaceInfo = { workspace, workspaceReal, rootReal, schemaPath: join(oldPrisma, 'schema.prisma') };
  try {
    ensure(copiedDirs.at(-1) === predecessorName, 'Temporary chain does not end at the approved predecessor.');
    mkdirSync(oldMigrations, { recursive: true });
    cpSync(currentSchema, workspaceInfo.schemaPath, { recursive: true });
    copyFileSync(resolve(migrationRoot, 'migration_lock.toml'), join(oldMigrations, 'migration_lock.toml'));
    for (const directory of copiedDirs) {
      const source = resolve(migrationRoot, directory);
      ensure(existsSync(join(source, 'migration.sql')), `Migration ${directory} has no migration.sql.`);
      cpSync(source, join(oldMigrations, directory), { recursive: true, errorOnExist: true });
    }
    return workspaceInfo;
  } catch (error) {
    cleanupPreviousMigrationWorkspace(workspaceInfo);
    throw error;
  }
}

function cleanupPreviousMigrationWorkspace(workspace) {
  const currentReal = realpathSync(workspace.workspace);
  ensure(
    currentReal === workspace.workspaceReal &&
      dirname(currentReal) === workspace.rootReal &&
      basename(currentReal).startsWith('.t054-prisma-chain-') &&
      !lstatSync(workspace.workspace).isSymbolicLink(),
    'Temporary migration workspace changed identity; preserving it for inspection.',
  );
  rmSync(currentReal, { recursive: true, force: false });
}

function createPrismaClient(databaseUrl) {
  const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
  const { PrismaClient } = apiRequire('@prisma/client');
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function query(client, sql, ...values) {
  return client.$queryRawUnsafe(sql, ...values);
}

async function execute(client, sql, ...values) {
  return client.$executeRawUnsafe(sql, ...values);
}

async function createFixedDatabases(adminClient) {
  const existing = await query(
    adminClient,
    `SELECT datname FROM pg_database WHERE datname IN ('feature029_slice62_fresh', 'feature029_slice62_upgrade')`,
  );
  ensure(existing.length === 0, 'A fixed T054 database name is already in use; refusing to reset or reuse it.');
  for (const databaseName of targetDatabases) {
    await execute(adminClient, `CREATE DATABASE "${databaseName}"`);
  }
}

async function ensureDatabase(client, expectedName) {
  const rows = await query(client, `SELECT current_database() AS database_name`);
  ensure(rows.length === 1 && rows[0].database_name === expectedName, `Connected to an unexpected database; expected ${expectedName}.`);
}

async function seedLegacyGraph(client) {
  // Pass Date objects so Prisma serializes parameters as PostgreSQL timestamps
  const timestamp = new Date('2026-09-01T10:00:00.000Z');
  const laterTimestamp = new Date('2026-09-02T10:00:00.000Z');

  await execute(
    client,
    `INSERT INTO "users" ("id", "email", "password", "updatedAt") VALUES ($1, $2, $3, $4)`,
    't054-user',
    't054-user@example.invalid',
    'not-a-real-password-hash',
    timestamp,
  );
  await execute(
    client,
    `INSERT INTO "flight_offers" ("id", "searchHash", "duffelOfferId", "rawOffer", "origin", "destination", "departureDate", "adults", "price") VALUES ($1, $2, $3, '{}'::jsonb, 'SFO', 'JFK', '2027-03-10', 1, 125.00)`,
    't054-flight-offer',
    't054-search-hash',
    't054-offer-sentinel',
  );
  await execute(
    client,
    `INSERT INTO "booking_intents" ("id", "userId", "flightOfferId", "duffelOfferId", "originalPrice", "confirmedPrice", "pricedAt", "origin", "destination", "departureDate", "adults", "rawOfferSnapshot", "intentExpiresAt", "updatedAt") VALUES ($1, $2, $3, $4, 125.00, 125.00, $5, 'SFO', 'JFK', '2027-03-10', 1, '{}'::jsonb, $6, $7), ($8, $2, NULL, $9, 150.00, 150.00, $5, 'SFO', 'JFK', '2027-03-11', 1, '{}'::jsonb, $6, $7)`,
    't054-intent-sentinel',
    't054-user',
    't054-flight-offer',
    't054-intent-offer-sentinel',
    timestamp,
    laterTimestamp,
    timestamp,
    't054-intent-null-control',
    't054-intent-null-offer',
  );
  await execute(
    client,
    `INSERT INTO "booking_intent_passengers" ("id", "intentId", "position", "type", "givenName", "familyName", "dateOfBirth", "gender", "duffelPassengerId") VALUES ($1, $2, 1, 'ADULT', 'Test', 'Sentinel', '1990-01-01', 'X', $3), ($4, $5, 1, 'ADULT', 'Test', 'Null', '1991-01-01', 'X', NULL)`,
    't054-passenger-sentinel',
    't054-intent-sentinel',
    't054-passenger-legacy-sentinel',
    't054-passenger-null-control',
    't054-intent-null-control',
  );
  await execute(
    client,
    `INSERT INTO "bookings" ("id", "userId", "bookingIntentId", "totalAmount", "duffelOrderId", "duffelCancellationQuoteId", "lastDuffelSyncedAt", "nextDuffelSyncAt", "updatedAt") VALUES ($1, $2, $3, 125.00, $4, $5, $6, $7, $8), ($9, $2, $10, 150.00, NULL, NULL, NULL, NULL, $8)`,
    't054-booking-sentinel',
    't054-user',
    't054-intent-sentinel',
    't054-order-sentinel',
    't054-cancellation-quote-sentinel',
    timestamp,
    laterTimestamp,
    timestamp,
    't054-booking-null-control',
    't054-intent-null-control',
  );
  await execute(
    client,
    `INSERT INTO "ancillary_selections" ("id", "bookingIntentId", "version", "currency", "seatTotal", "baggageTotal", "total", "catalogFingerprint", "updatedAt") VALUES ($1, $2, 1, 'USD', 10.00, 20.00, 30.00, 't054-catalog-sentinel', $3), ($4, $5, 1, 'USD', 0.00, 0.00, 0.00, 't054-catalog-null-control', $3)`,
    't054-ancillary-sentinel',
    't054-intent-sentinel',
    timestamp,
    't054-ancillary-null-control',
    't054-intent-null-control',
  );
  await execute(
    client,
    `INSERT INTO "seat_selections" ("id", "ancillarySelectionId", "intentPassengerId", "duffelPassengerId", "segmentId", "serviceId", "seatDesignator", "amount", "currency", "updatedAt") VALUES ($1, $2, $3, $4, 't054-segment-1', 't054-seat-service-1', '12A', 10.00, 'USD', $5), ($6, $7, $8, $9, 't054-segment-2', 't054-seat-service-2', '14C', 0.00, 'USD', $5)`,
    't054-seat-sentinel',
    't054-ancillary-sentinel',
    't054-passenger-sentinel',
    't054-passenger-legacy-sentinel',
    timestamp,
    't054-seat-null-control',
    't054-ancillary-null-control',
    't054-passenger-null-control',
    't054-seat-null-passenger-control',
  );
  await execute(
    client,
    `INSERT INTO "baggage_selections" ("id", "ancillarySelectionId", "intentPassengerId", "duffelPassengerId", "serviceId", "type", "quantity", "amount", "currency", "updatedAt") VALUES ($1, $2, $3, $4, 't054-baggage-service-1', 'CHECKED', 1, 20.00, 'USD', $5), ($6, $7, $8, $9, 't054-baggage-service-2', 'CHECKED', 1, 0.00, 'USD', $5)`,
    't054-baggage-sentinel',
    't054-ancillary-sentinel',
    't054-passenger-sentinel',
    't054-passenger-legacy-sentinel',
    timestamp,
    't054-baggage-null-control',
    't054-ancillary-null-control',
    't054-passenger-null-control',
    't054-baggage-null-passenger-control',
  );
  await execute(
    client,
    `INSERT INTO "itinerary_revisions" ("id", "bookingId", "version", "source", "fingerprint", "isMaterial", "materialReasons", "materialBaselines", "incrementalDiff", "cumulativeDiff") VALUES ($1, $2, 1, 'BOOTSTRAP', 't054-revision-fingerprint', false, ARRAY[]::"MaterialDisruptionReason"[], ARRAY[]::"MaterialBaseline"[], '{}'::jsonb, '{}'::jsonb)`,
    't054-revision-sentinel',
    't054-booking-sentinel',
  );
  await execute(
    client,
    `INSERT INTO "itinerary_revision_segments" ("id", "revisionId", "sliceOrder", "segmentOrder", "globalOrder", "duffelSegmentId", "marketingCarrierIata", "airlineName", "flightNumber", "departureAirportIata", "departureAirportName", "departureCity", "departureAt", "departureLocalDate", "arrivalAirportIata", "arrivalAirportName", "arrivalCity", "arrivalAt", "arrivalLocalDate", "durationMinutes") VALUES ($1, $2, 0, 0, 0, $3, 'ZZ', 'Test Carrier', '101', 'SFO', 'San Francisco', 'San Francisco', '2027-03-10T08:00:00.000Z', '2027-03-10', 'JFK', 'John F Kennedy', 'New York', '2027-03-10T16:00:00.000Z', '2027-03-10', 480), ($4, $2, 0, 1, 1, NULL, 'ZZ', 'Test Carrier', '102', 'JFK', 'John F Kennedy', 'New York', '2027-03-10T18:00:00.000Z', '2027-03-10', 'BOS', 'Logan', 'Boston', '2027-03-10T19:00:00.000Z', '2027-03-10', 60)`,
    't054-segment-sentinel',
    't054-revision-sentinel',
    't054-itinerary-segment-sentinel',
    't054-segment-null-control',
  );
  await execute(
    client,
    `INSERT INTO "chat_sessions" ("id", "userId", "updatedAt") VALUES ('t054-chat-session', 't054-user', $1)`,
    timestamp,
  );
  await execute(
    client,
    `INSERT INTO "chat_handoffs" ("id", "userId", "chatSessionId", "flightOfferId", "duffelOfferIdHash", "snapshotVersion", "snapshotFingerprint", "selectionAttestationHash", "selectedOfferIndex", "tokenHash", "tokenKeyVersion", "idempotencyKeyHash", "expiresAt", "updatedAt") VALUES ('t054-chat-handoff', 't054-user', 't054-chat-session', 't054-flight-offer', 't054-handoff-offer-hash-sentinel', 1, 't054-snapshot-fingerprint', 't054-attestation-hash', 1, 't054-token-hash', 1, 't054-idempotency-hash', $1, $2)`,
    laterTimestamp,
    timestamp,
  );
  await execute(
    client,
    `INSERT INTO "duffel_webhook_events" ("id", "supplierEventId", "duffelOrderId", "eventType", "status", "updatedAt") VALUES ($1, 't054-webhook-sentinel-event', 't054-webhook-order-sentinel', 'order.updated', 'PENDING', $2), ($3, 't054-webhook-null-event', NULL, 'order.created', 'PENDING', $2)`,
    't054-webhook-sentinel',
    timestamp,
    't054-webhook-null-control',
  );
}

async function readSnapshot(client, legacy) {
  const result = {};
  for (const table of tables) {
    const names = table.fields
      .map(([oldName, currentName]) => `"${legacy ? oldName : currentName}" AS "${currentName}"`)
      .join(', ');
    const identityNames = table.identities.map((name) => `"${name}"`).join(', ');
    result[table.name] = await query(
      client,
      `SELECT ${identityNames}, ${names} FROM "${table.name}" ORDER BY "id"`,
    );
  }
  result.webhookEvents = await query(
    client,
    `SELECT "id", "supplierEventId", "duffelOrderId" FROM "duffel_webhook_events" ORDER BY "id"`,
  );
  return result;
}

function checkFixtureValues(snapshot) {
  const sentinel = (table, id) => snapshot[table].find((row) => row.id === id);
  const expectedSentinels = [
    [sentinel('bookings', 't054-booking-sentinel'), 'supplierOrderId', 't054-order-sentinel'],
    [
      sentinel('bookings', 't054-booking-sentinel'),
      'supplierCancellationQuoteId',
      't054-cancellation-quote-sentinel',
    ],
    [sentinel('booking_intents', 't054-intent-sentinel'), 'supplierOfferId', 't054-intent-offer-sentinel'],
    [
      sentinel('booking_intent_passengers', 't054-passenger-sentinel'),
      'supplierPassengerId',
      't054-passenger-legacy-sentinel',
    ],
    [
      sentinel('seat_selections', 't054-seat-sentinel'),
      'supplierPassengerId',
      't054-passenger-legacy-sentinel',
    ],
    [
      sentinel('baggage_selections', 't054-baggage-sentinel'),
      'supplierPassengerId',
      't054-passenger-legacy-sentinel',
    ],
    [sentinel('flight_offers', 't054-flight-offer'), 'supplierOfferId', 't054-offer-sentinel'],
    [
      sentinel('itinerary_revision_segments', 't054-segment-sentinel'),
      'supplierSegmentId',
      't054-itinerary-segment-sentinel',
    ],
    [sentinel('chat_handoffs', 't054-chat-handoff'), 'supplierOfferIdHash', 't054-handoff-offer-hash-sentinel'],
  ];
  for (const [row, field, value] of expectedSentinels) {
    ensure(row && row[field] === value, `Expected linked sentinel ${field} was not preserved.`);
  }

  const nullableControls = [
    ['bookings', 't054-booking-null-control', [
      'supplierOrderId', 'supplierCancellationQuoteId', 'lastSupplierSyncedAt', 'nextSupplierSyncAt',
    ]],
    ['booking_intents', 't054-intent-null-control', ['flightOfferId']],
    ['booking_intent_passengers', 't054-passenger-null-control', ['supplierPassengerId']],
    ['itinerary_revision_segments', 't054-segment-null-control', ['supplierSegmentId']],
  ];
  for (const [table, id, fields] of nullableControls) {
    const row = sentinel(table, id);
    ensure(row, `Expected null-control row ${id} was not preserved.`);
    for (const field of fields) ensure(row[field] === null, `Expected ${table}.${field} null control was not preserved.`);
  }
  const webhook = snapshot.webhookEvents.find((row) => row.id === 't054-webhook-sentinel');
  const webhookNull = snapshot.webhookEvents.find((row) => row.id === 't054-webhook-null-control');
  ensure(webhook && webhook.duffelOrderId === 't054-webhook-order-sentinel', 'Webhook order sentinel changed.');
  ensure(webhookNull && webhookNull.duffelOrderId === null, 'Webhook nullable order control changed.');

  const links = [
    ['bookings', 't054-booking-sentinel', 'userId', 't054-user'],
    ['bookings', 't054-booking-sentinel', 'bookingIntentId', 't054-intent-sentinel'],
    ['booking_intents', 't054-intent-sentinel', 'flightOfferId', 't054-flight-offer'],
    ['booking_intent_passengers', 't054-passenger-sentinel', 'intentId', 't054-intent-sentinel'],
    ['seat_selections', 't054-seat-sentinel', 'ancillarySelectionId', 't054-ancillary-sentinel'],
    ['seat_selections', 't054-seat-sentinel', 'intentPassengerId', 't054-passenger-sentinel'],
    ['baggage_selections', 't054-baggage-sentinel', 'ancillarySelectionId', 't054-ancillary-sentinel'],
    ['baggage_selections', 't054-baggage-sentinel', 'intentPassengerId', 't054-passenger-sentinel'],
    ['itinerary_revision_segments', 't054-segment-sentinel', 'revisionId', 't054-revision-sentinel'],
    ['chat_handoffs', 't054-chat-handoff', 'userId', 't054-user'],
    ['chat_handoffs', 't054-chat-handoff', 'chatSessionId', 't054-chat-session'],
    ['chat_handoffs', 't054-chat-handoff', 'flightOfferId', 't054-flight-offer'],
  ];
  for (const [table, id, field, value] of links) {
    ensure(sentinel(table, id)?.[field] === value, `Expected linked ${table}.${field} reference changed.`);
  }
  const bookingSentinel = sentinel('bookings', 't054-booking-sentinel');
  ensure(
    bookingSentinel.lastSupplierSyncedAt !== null && bookingSentinel.nextSupplierSyncAt !== null,
    'Booking sync timestamp sentinels were not preserved.',
  );
  return {
    renamedValuesChecked: expectedSentinels.length + 2,
    linkChecks: links.length,
    nullControlsChecked: nullableControls.reduce((count, [, , fields]) => count + fields.length, 1),
    webhookRows: snapshot.webhookEvents.length,
  };
}

async function checkColumns(client, legacy) {
  const columns = await query(
    client,
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'bookings' AND column_name IN ('duffelOrderId', 'supplierOrderId', 'duffelCancellationQuoteId', 'supplierCancellationQuoteId', 'lastDuffelSyncedAt', 'lastSupplierSyncedAt', 'nextDuffelSyncAt', 'nextSupplierSyncAt'))
          OR (table_name = 'booking_intents' AND column_name IN ('duffelOfferId', 'supplierOfferId'))
          OR (table_name IN ('booking_intent_passengers', 'seat_selections', 'baggage_selections') AND column_name IN ('duffelPassengerId', 'supplierPassengerId'))
          OR (table_name = 'flight_offers' AND column_name IN ('duffelOfferId', 'supplierOfferId'))
          OR (table_name = 'itinerary_revision_segments' AND column_name IN ('duffelSegmentId', 'supplierSegmentId'))
          OR (table_name = 'chat_handoffs' AND column_name IN ('duffelOfferIdHash', 'supplierOfferIdHash'))
          OR (table_name = 'duffel_webhook_events' AND column_name = 'duffelOrderId'))`,
  );
  const catalog = new Map(columns.map((column) => [`${column.table_name}.${column.column_name}`, column.is_nullable]));
  for (const field of columnExpectations) {
    const expectedName = legacy ? field.old : field.current;
    const oldName = `${field.table}.${field.old}`;
    const newName = `${field.table}.${field.current}`;
    ensure(catalog.has(`${field.table}.${expectedName}`), `Expected migration column ${expectedName} is missing.`);
    ensure(
      catalog.get(`${field.table}.${expectedName}`) === (field.nullable ? 'YES' : 'NO'),
      `Nullability changed for ${field.table}.${expectedName}.`,
    );
    ensure(!catalog.has(legacy ? newName : oldName), `Unexpected old/new column remains on ${field.table}.`);
  }
  ensure(catalog.has('duffel_webhook_events.duffelOrderId'), 'Duffel webhook order column must remain unchanged.');
  ensure(columns.length === 12, 'Expected exactly eleven renamed columns and the preserved webhook column.');
}

async function readIndexes(client) {
  return query(
    client,
    `SELECT index_relation.relname AS index_name,
            table_relation.relname AS table_name,
            index_data.indisunique AS is_unique,
            pg_get_indexdef(index_data.indexrelid) AS definition,
            array_agg(attribute_data.attname ORDER BY ordered_key.ordinality) AS ordered_columns
       FROM pg_index AS index_data
       JOIN pg_class AS index_relation ON index_relation.oid = index_data.indexrelid
       JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
       JOIN pg_namespace AS namespace_data ON namespace_data.oid = table_relation.relnamespace
       JOIN LATERAL unnest(index_data.indkey) WITH ORDINALITY AS ordered_key(attribute_number, ordinality)
         ON ordered_key.ordinality <= index_data.indnkeyatts
       JOIN pg_attribute AS attribute_data
         ON attribute_data.attrelid = table_relation.oid
        AND attribute_data.attnum = ordered_key.attribute_number
      WHERE namespace_data.nspname = current_schema()
        AND index_relation.relname IN (
          'bookings_supplierOrderId_idx',
          'bookings_status_nextUnflownDepartureAt_lastSupplierSyncedAt_idx',
          'booking_intent_passengers_intentId_supplierPassengerId_idx',
          'flight_offers_searchHash_supplierOfferId_key',
          'itinerary_revision_segments_supplierSegmentId_idx',
          'bookings_duffelOrderId_idx',
          'bookings_status_nextUnflownDepartureAt_lastDuffelSyncedAt_idx',
          'booking_intent_passengers_intentId_duffelPassengerId_idx',
          'flight_offers_searchHash_duffelOfferId_key',
          'itinerary_revision_segments_duffelSegmentId_idx',
          'duffel_webhook_events_duffelOrderId_createdAt_idx'
        )
      GROUP BY index_relation.relname, table_relation.relname, index_data.indisunique, index_data.indexrelid`,
  );
}

async function checkIndexes(client, legacy, previousWebhookDefinition) {
  const indexes = await readIndexes(client);
  const byName = new Map(indexes.map((index) => [index.index_name, index]));
  const expected = legacy
    ? requiredIndexes.map((index, position) => ({
        ...index,
        name: legacyIndexNames[position],
        columns: index.legacyColumns,
      }))
    : requiredIndexes;
  for (const index of expected) {
    const found = byName.get(index.name);
    ensure(found, `Expected index ${index.name} is missing.`);
    ensure(found.table_name === index.table, `Index ${index.name} is on the wrong table.`);
    ensure(Boolean(found.is_unique) === index.unique, `Index ${index.name} changed uniqueness.`);
    // User approval (2026-10-03): compare catalog key order directly; pg_get_indexdef omits quotes around lowercase identifiers.
    ensure(
      JSON.stringify(found.ordered_columns) === JSON.stringify(index.columns),
      `Index ${index.name} column order changed.`,
    );
  }
  if (legacy) {
    for (const index of requiredIndexes) ensure(!byName.has(index.name), `Neutral index ${index.name} unexpectedly exists before upgrade.`);
  } else {
    for (const name of legacyIndexNames) ensure(!byName.has(name), `Legacy index ${name} remains after upgrade.`);
  }
  const webhook = byName.get(webhookIndexName);
  ensure(webhook, 'Duffel webhook order index is missing.');
  ensure(
    webhook.definition.includes('("duffelOrderId", "createdAt" DESC)'),
    'Duffel webhook order index definition changed.',
  );
  if (previousWebhookDefinition !== undefined) {
    ensure(webhook.definition === previousWebhookDefinition, 'Duffel webhook order index was modified by the rename migration.');
  }
  return webhook.definition;
}

async function checkUniqueOffer(client, legacy) {
  const offerColumn = legacy ? 'duffelOfferId' : 'supplierOfferId';
  const result = await query(
    client,
    `INSERT INTO "flight_offers" ("id", "searchHash", "${offerColumn}", "rawOffer", "origin", "destination", "departureDate", "adults", "price") VALUES ('t054-duplicate-offer', 't054-search-hash', 't054-offer-sentinel', '{}'::jsonb, 'SFO', 'JFK', '2027-03-10', 1, 125.00) ON CONFLICT ("searchHash", "${offerColumn}") DO NOTHING RETURNING "id"`,
  );
  ensure(result.length === 0, 'Offer pair uniqueness no longer rejects a duplicate supplier offer.');
}

async function checkMigrationStatus(databaseName, databaseUrl, schemaPath, guard) {
  runPrismaCommand('status', databaseName, databaseUrl, schemaPath, guard);
}

async function migrationState(client, targetExpected) {
  const rows = await query(
    client,
    `SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::integer AS applied_count,
            count(*) FILTER (WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL)::integer AS target_count,
            count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::integer AS unfinished_count
       FROM "_prisma_migrations"`,
    migrationName,
  );
  const state = rows[0];
  ensure(state && state.applied_count > 0, 'Prisma migration history contains no successful migrations.');
  ensure(state.unfinished_count === 0, 'Prisma migration history contains an unfinished migration.');
  ensure(state.target_count === (targetExpected ? 1 : 0), 'Forward migration history does not match the expected phase.');
  return { appliedCount: state.applied_count, targetMigrationApplied: state.target_count === 1 };
}

async function proveMigrations(adminUrl) {
  const guard = networkGuardPath();
  requireFromHarness(guard);
  const guardForChildren = guard.replaceAll('\\', '/');
  const freshUrl = adminUrlForTarget(adminUrl, targetDatabases[0]);
  const upgradeUrl = adminUrlForTarget(adminUrl, targetDatabases[1]);
  const adminClient = createPrismaClient(adminUrl);
  let freshClient;
  let upgradeClient;
  let previousWorkspace;
  let summary;
  try {
    await ensureDatabase(adminClient, 'postgres');
    await createFixedDatabases(adminClient);

    freshClient = createPrismaClient(freshUrl);
    await ensureDatabase(freshClient, targetDatabases[0]);
    runPrismaCommand('deploy', targetDatabases[0], freshUrl, currentSchema, guardForChildren);
    await checkColumns(freshClient, false);
    const freshWebhookIndex = await checkIndexes(freshClient, false);
    await checkMigrationStatus(targetDatabases[0], freshUrl, currentSchema, guardForChildren);
    const freshMigrations = await migrationState(freshClient, true);

    previousWorkspace = previousMigrationWorkspace();
    upgradeClient = createPrismaClient(upgradeUrl);
    await ensureDatabase(upgradeClient, targetDatabases[1]);
    runPrismaCommand(
      'deploy',
      targetDatabases[1],
      upgradeUrl,
      previousWorkspace.schemaPath,
      guardForChildren,
    );
    await seedLegacyGraph(upgradeClient);
    await checkColumns(upgradeClient, true);
    const previousWebhookIndex = await checkIndexes(upgradeClient, true);
    const before = await readSnapshot(upgradeClient, true);
    checkFixtureValues(before);
    ensure(previousWebhookIndex === freshWebhookIndex, 'Fresh and previous-chain webhook indexes do not match.');
    await checkUniqueOffer(upgradeClient, true);
    await checkMigrationStatus(
      targetDatabases[1],
      upgradeUrl,
      previousWorkspace.schemaPath,
      guardForChildren,
    );
    const previousMigrations = await migrationState(upgradeClient, false);

    runPrismaCommand('deploy', targetDatabases[1], upgradeUrl, currentSchema, guardForChildren);
    await checkColumns(upgradeClient, false);
    await checkIndexes(upgradeClient, false, previousWebhookIndex);
    const after = await readSnapshot(upgradeClient, false);
    const fixtureProof = checkFixtureValues(after);
    ensure(JSON.stringify(before) === JSON.stringify(after), 'Forward migration changed legacy sentinels or their links.');
    await checkUniqueOffer(upgradeClient, false);
    await checkMigrationStatus(targetDatabases[1], upgradeUrl, currentSchema, guardForChildren);
    const upgradedMigrations = await migrationState(upgradeClient, true);
    const sentinelRows = Object.values(after).reduce((count, rows) => count + rows.length, 0);
    summary = {
      fresh: {
        database: targetDatabases[0],
        migrationStatus: 'up-to-date',
        appliedMigrations: freshMigrations.appliedCount,
        renamedColumnsChecked: columnExpectations.length,
        renamedIndexesChecked: requiredIndexes.length,
        webhookIndexPreserved: true,
      },
      upgrade: {
        database: targetDatabases[1],
        previousChainStatus: 'up-to-date',
        previousChainMigrations: previousMigrations.appliedCount,
        currentChainStatus: 'up-to-date',
        currentChainMigrations: upgradedMigrations.appliedCount,
        targetMigrationApplied: upgradedMigrations.targetMigrationApplied,
        renamedColumnsChecked: fixtureProof.renamedValuesChecked,
        renamedIndexesChecked: requiredIndexes.length,
        sentinelRowsPreserved: sentinelRows,
        linkedSentinelChecks: fixtureProof.linkChecks,
        nullControlsChecked: fixtureProof.nullControlsChecked,
        supplierOfferUniquenessPreserved: true,
        webhookRowsPreserved: fixtureProof.webhookRows,
        webhookIndexPreserved: true,
      },
    };
  } finally {
    try {
      await Promise.all(
        [upgradeClient, freshClient, adminClient]
          .filter((client) => client !== undefined)
          .map((client) => client.$disconnect()),
      );
    } finally {
      if (previousWorkspace) cleanupPreviousMigrationWorkspace(previousWorkspace);
    }
  }
  return summary;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const adminUrl = process.env.T054_ADMIN_DATABASE_URL;
    getPreflightSummary(adminUrl);
    if (process.argv.includes('--preflight')) {
      process.stdout.write(`${JSON.stringify(getPreflightSummary(adminUrl))}\n`);
    } else {
      const summary = await proveMigrations(adminUrl);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'T054 migration proof failed.'}\n`);
    process.exitCode = 1;
  }
}
