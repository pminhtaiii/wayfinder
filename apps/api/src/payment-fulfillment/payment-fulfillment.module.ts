import { Module } from '@nestjs/common';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { StripeModule } from '@/common/stripe.module';
import { SupplierOrderModule } from '@/supplier/order/supplier-order.module';
import { PaymentMethodsModule } from '@/payment/payment-methods.module';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { BookingIntentModule } from '@/booking-intent/booking-intent.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuditModule } from '@/audit/audit.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { SupplierSearchModule } from '@/supplier/search/supplier-search.module';
import { PaymentFulfillmentSaga } from './payment-fulfillment.saga';

@Module({
  imports: [
    IdempotencyModule,
    StripeModule,
    SupplierOrderModule,
    PaymentMethodsModule,
    BookingLifecycleModule,
    BookingIntentModule,
    PrismaModule,
    AuditModule,
    DomainEventsModule,
    SupplierSearchModule,
  ],
  providers: [PaymentFulfillmentSaga],
  exports: [PaymentFulfillmentSaga],
})
export class PaymentFulfillmentModule {}
