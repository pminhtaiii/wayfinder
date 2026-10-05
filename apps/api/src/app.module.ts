import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { ChatModule } from './chat/chat.module';
import { AgentGatewayModule } from './agent-gateway/agent-gateway.module';
import { AgentAuthModule } from './agent-gateway/auth/agent-auth.module';
import { AgentToolAuditModule } from './agent-gateway/audit/agent-tool-audit.module';
import { AttestedFlightSearchModule } from './agent-gateway/attested-flight-search/attested-flight-search.module';
import { AgentBookingReadinessModule } from './agent-gateway/booking-readiness/agent-booking-readiness.module';
import { SafeBookingReadModule } from './agent-gateway/safe-booking-read/safe-booking-read.module';
import { TravelerPreferencesModule } from './agent-gateway/traveler-preferences/traveler-preferences.module';
import { AirportsModule } from './airports/airports.module';
import { SupplierOrderModule } from './supplier/order/supplier-order.module';
import { SupplierSearchModule } from './supplier/search/supplier-search.module';
import { FlightsModule } from './flights/flights.module';
import { BookingIntentModule } from './booking-intent/booking-intent.module';
import { BookingLifecycleModule } from './booking-lifecycle/booking-lifecycle.module';
import { BookingProjectionModule } from './booking-projection/booking-projection.module';
import { BookingManagementModule } from './booking-management/booking-management.module';
import { CancellationModule } from './cancellation/cancellation.module';
import { PaymentModule } from './payment/payment.module';

import { DisruptionModule } from './disruption/disruption.module';
import { AncillariesModule } from './ancillaries/ancillaries.module';
import { ProfileModule } from './profile/profile.module';
import { ChatHandoffModule } from './chat-handoff/chat-handoff.module';
import { DataDriftSentinelModule } from './common/sentinel/data-drift-sentinel.module';
import { BookingReadinessMetricsModule } from './common/observability/booking-readiness-metrics.module';
import { RefundModule } from './refund/refund.module';
import { RefundSettlementModule } from './refund-settlement/refund-settlement.module';
import { DashboardModule } from './dashboard/dashboard.module';

import { StripeModule } from './common/stripe.module';

import { z } from 'zod';

export const envSchema = z
  .object({
    PORT: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    REDIS_URL: z.string().optional(),
    STRIPE_SECRET_KEY: z.string({
      required_error: 'STRIPE_SECRET_KEY is required',
    }),
    STRIPE_WEBHOOK_SECRET: z.string({
      required_error: 'STRIPE_WEBHOOK_SECRET is required',
    }),
    JWT_SECRET: z.string().optional(),
    ENCRYPTION_KEY: z.string().optional(),
    DUFFEL_WEBHOOK_SECRET: z.string().optional(),
    FEATURE_FLAG_DISRUPTION_INGRESS: z.string().optional().default('false'),
    FEATURE_FLAG_BOOKING_READINESS: z.string().optional().default('false'),
    FEATURE_FLAG_DISRUPTION_PROCESSOR: z.string().optional().default('false'),
    FEATURE_FLAG_DISRUPTION_RECONCILIATION: z.string().optional().default('false'),
    FEATURE_FLAG_DISRUPTION_SURFACING: z.string().optional().default('false'),
    FEATURE_FLAG_DISRUPTION_OUTBOX: z.string().optional().default('false'),
    FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: z.string().optional().default('false'),
    FEATURE_FLAG_CHAT_HANDOFF_ISSUE: z.string().optional().default('false'),
    FEATURE_FLAG_WRITE_FENCE: z.string().optional().default('false'),
    CHAT_ENCRYPTION_KEY: z.string().optional(),
    CHAT_ATTESTATION_KEY: z.string().optional(),
    CHAT_HANDOFF_SECRET: z.string().optional(),
    CHAT_HANDOFF_SECRET_V1: z.string().optional(),
    CHAT_HANDOFF_SECRET_V2: z.string().optional(),
    CHAT_HANDOFF_SECRET_V3: z.string().optional(),
    CHAT_HANDOFF_CLAIM_TTL: z.coerce.number().optional().default(600),
    STRIPE_ADMISSION_ACTIVE_LIMIT: z
      .string()
      .regex(/^[1-9]\d*$/, 'STRIPE_ADMISSION_ACTIVE_LIMIT must be a positive integer string')
      .optional(),
    STRIPE_ADMISSION_QUEUE_LIMIT: z
      .string()
      .regex(/^[1-9]\d*$/, 'STRIPE_ADMISSION_QUEUE_LIMIT must be a positive integer string')
      .optional(),
    STRIPE_ADMISSION_TIMEOUT_MS: z
      .string()
      .regex(/^[1-9]\d*$/, 'STRIPE_ADMISSION_TIMEOUT_MS must be a positive integer string')
      .optional(),
    DUFFEL_ADMISSION_ACTIVE_LIMIT: z
      .string()
      .regex(/^[1-9]\d*$/, 'DUFFEL_ADMISSION_ACTIVE_LIMIT must be a positive integer string')
      .optional(),
    DUFFEL_ADMISSION_QUEUE_LIMIT: z
      .string()
      .regex(/^[1-9]\d*$/, 'DUFFEL_ADMISSION_QUEUE_LIMIT must be a positive integer string')
      .optional(),
    DUFFEL_ADMISSION_TIMEOUT_MS: z
      .string()
      .regex(/^[1-9]\d*$/, 'DUFFEL_ADMISSION_TIMEOUT_MS must be a positive integer string')
      .optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      if (
        data.FEATURE_FLAG_CHAT_HANDOFF_ISSUE === 'true' &&
        data.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT !== 'true'
      ) {
        return false;
      }
      return true;
    },
    {
      message: 'Invalid config: ISSUE=true but ACCEPT=false',
    },
  );

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', maxListeners: 20 }),
    PrismaModule,
    StripeModule,
    HealthModule,
    CacheModule,
    AuthModule,
    AuditModule,
    ChatModule,
    AgentGatewayModule,
    AgentAuthModule,
    AgentToolAuditModule,
    AttestedFlightSearchModule,
    AgentBookingReadinessModule,
    SafeBookingReadModule,
    TravelerPreferencesModule,
    AirportsModule,
    SupplierOrderModule,
    SupplierSearchModule,
    FlightsModule,
    BookingIntentModule,
    BookingLifecycleModule,
    /**
     * Architectural Note: Feature 024 Event-Driven Projection Cutover
     *
     * US2 (event-driven safe booking projection) and US3 (reconciliation repair loop)
     * share a single atomic deployment boundary (tasks.md lines 36, 81; plan.md line 28).
     *
     * In accordance with T032, BookingProjectionModule is registered here alongside root
     * EventEmitterModule.forRoot to support event-driven projection updates in this feature branch.
     * Full production cutover requires Phase 5 (US3 reconciliation loop, tasks T035-T040)
     * to be completed on branch 024-event-driven-module-deepening before merging to development,
     * ensuring transient in-memory dispatch losses or restarts are repaired autonomously by DB scan.
     */
    BookingProjectionModule,
    BookingManagementModule,
    CancellationModule,
    PaymentModule,

    DisruptionModule,
    AncillariesModule,
    ProfileModule,
    ChatHandoffModule,
    DataDriftSentinelModule,
    BookingReadinessMetricsModule,
    RefundModule,
    RefundSettlementModule,
    DashboardModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
