import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { PaymentService } from '@/payment/payment.service';
import { PaymentModule } from '@/payment/payment.module';
import { PrismaService } from '@/prisma/prisma.service';
import { FulfillmentWorkflowRepository } from './fulfillment-workflow.repository';
import { PaymentFulfillmentModule } from './payment-fulfillment.module';
import { ProviderOperationService } from './provider-operation.service';

function testRootModules() {
  return [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', maxListeners: 20 }),
  ];
}

@Injectable()
class FulfillmentJournalConsumer {
  constructor(
    readonly workflows: FulfillmentWorkflowRepository,
    readonly operations: ProviderOperationService,
  ) {}
}

@Module({
  imports: [PaymentFulfillmentModule],
  providers: [FulfillmentJournalConsumer],
})
class FulfillmentJournalConsumerModule {}

@Injectable()
class PaymentApiConsumer {
  constructor(readonly payments: PaymentService) {}
}

@Module({ imports: [PaymentModule], providers: [PaymentApiConsumer] })
class PaymentApiConsumerModule {}

@Injectable()
class UnrelatedJournalConsumer {
  constructor(readonly operations: ProviderOperationService) {}
}

@Module({ providers: [UnrelatedJournalConsumer] })
class UnrelatedJournalConsumerModule {}

describe('Payment fulfillment module composition', () => {
  it('exports actual journal services to an importing Nest consumer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [...testRootModules(), FulfillmentJournalConsumerModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    try {
      const consumer = moduleRef.get(FulfillmentJournalConsumer);

      expect(consumer.workflows).toBeInstanceOf(FulfillmentWorkflowRepository);
      expect(consumer.operations).toBeInstanceOf(ProviderOperationService);
    } finally {
      await moduleRef.close();
    }
  });

  it('resolves PaymentService through the existing PaymentModule import', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [...testRootModules(), PaymentApiConsumerModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    try {
      const consumer = moduleRef.get(PaymentApiConsumer);

      expect(consumer.payments).toBeInstanceOf(PaymentService);
    } finally {
      await moduleRef.close();
    }
  });

  it('does not expose journal services to unrelated sibling modules', async () => {
    const moduleRef = Test.createTestingModule({
      imports: [...testRootModules(), PaymentFulfillmentModule, UnrelatedJournalConsumerModule],
    })
      .overrideProvider(PrismaService)
      .useValue({});

    await expect(moduleRef.compile()).rejects.toThrow(/UnrelatedJournalConsumer/);
  });
});
