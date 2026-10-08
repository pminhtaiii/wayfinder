import 'reflect-metadata';
import { PaymentService } from './payment.service';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

describe('PaymentService', () => {
  let service: PaymentService;
  let mockPrisma: any;
  let mockStripe: any;
  let mockIdempotency: any;
  let mockAudit: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn((cb) => cb(mockPrisma)),
      bookingIntent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      payment: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };

    mockStripe = {
      createPaymentIntent: jest.fn(),
      cancelPaymentIntent: jest.fn(),
    };

    mockIdempotency = {
      computeHash: jest.fn().mockReturnValue('mock-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      getResumePoint: jest.fn(),
      updateRecoveryPoint: jest.fn().mockResolvedValue({}),
      completeKey: jest.fn().mockResolvedValue({}),
    };

    mockAudit = {
      createLog: jest.fn().mockResolvedValue({}),
    };

    service = new PaymentService(
      mockPrisma as unknown as PrismaService,
      mockStripe as unknown as StripeService,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockAudit as unknown as AuditService,
    );
  });

  describe('createPayment - stale-lock retry', () => {
    const dto = {
      bookingIntentId: 'intent-123',
      paymentMethodId: 'pm_123',
      saveCard: false,
    };
    const idempotencyKey = 'key-123';
    const userId = 'user-123';
    const ipAddress = '127.0.0.1';

    beforeEach(() => {
      mockPrisma.$transaction = jest.fn().mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.$queryRaw = jest.fn().mockResolvedValue([
        {
          id: 'intent-123',
          status: 'PENDING',
          paymentAttemptCount: 1,
          confirmedPrice: 100,
          currency: 'USD',
          userId: 'user-123',
        },
      ]);
      mockPrisma.$executeRaw = jest.fn().mockResolvedValue(1);
      mockPrisma.bookingIntent.findUnique = jest.fn().mockResolvedValue({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 1,
        confirmedPrice: 100,
        currency: 'USD',
        userId: 'user-123',
      });
      mockPrisma.payment.findFirst = jest.fn();
      mockPrisma.payment.create = jest.fn();
      mockPrisma.user = {
        findUnique: jest.fn().mockResolvedValue({
          email: 'test@example.com',
          stripeCustomerId: 'cus_123',
        }),
        updateMany: jest.fn(),
      };
      mockPrisma.idempotencyKey = {
        findUnique: jest.fn().mockResolvedValue({ id: 'key_id_123' }),
      };
      mockPrisma.paymentEvent = {
        create: jest.fn().mockResolvedValue({}),
      };
      mockAudit.createLog = jest.fn().mockResolvedValue({});
      mockIdempotency.updateRecoveryPoint = jest.fn().mockResolvedValue({});

      mockStripe.createPaymentIntent = jest.fn().mockResolvedValue({
        id: 'pi_123',
        client_secret: 'secret_123',
      });
    });

    it('should skip booking intent count increment when payment already exists for the idempotency key', async () => {
      const mockPayment = {
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        attemptNumber: 1,
        idempotencyKeyId: 'key_id_123',
        stripePaymentIntentId: 'pi_123',
        stripeCustomerId: 'cus_123',
        amount: 10000,
        currency: 'usd',
        status: 'CREATED',
      };

      mockPrisma.payment.findFirst.mockResolvedValue(mockPayment);

      const response = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(response).toEqual({
        paymentId: 'payment-123',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });

    it('should proceed with incrementing booking intent count and creating payment when no payment exists', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      mockPrisma.payment.create.mockResolvedValue({
        id: 'payment-456',
        status: 'CREATED',
      });

      const response = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
      expect(mockPrisma.payment.create).toHaveBeenCalled();
      expect(response).toEqual({
        paymentId: 'payment-456',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });

    it('should complete successfully even if paymentAttemptCount is already 2 (exhausted limit) if payment record exists', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 2,
        confirmedPrice: 100,
        currency: 'USD',
        userId: 'user-123',
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-123',
          status: 'PENDING',
          paymentAttemptCount: 2,
          confirmedPrice: 100,
          currency: 'USD',
          userId: 'user-123',
        },
      ]);

      const mockPayment = {
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        attemptNumber: 1,
        idempotencyKeyId: 'key_id_123',
        stripePaymentIntentId: 'pi_123',
        stripeCustomerId: 'cus_123',
        amount: 10000,
        currency: 'usd',
        status: 'CREATED',
      };

      mockPrisma.payment.findFirst.mockResolvedValue(mockPayment);

      const response = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(response).toEqual({
        paymentId: 'payment-123',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });
  });

  describe('getPaymentStatus', () => {
    it('returns payment and booking status when payment exists and user owns it', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'pay-123',
        status: 'CREATED',
        amount: 5000,
        currency: 'usd',
        attemptNumber: 1,
        bookingIntent: {
          id: 'intent-123',
          userId: 'user-123',
          status: 'AWAITING_PAYMENT',
        },
      });

      const result = await service.getPaymentStatus('pay-123', 'user-123');

      expect(mockPrisma.payment.findUnique).toHaveBeenCalledWith({
        where: { id: 'pay-123' },
        include: { bookingIntent: true },
      });
      expect(result).toEqual({
        paymentId: 'pay-123',
        status: 'CREATED',
        amount: 5000,
        currency: 'usd',
        bookingIntentStatus: 'AWAITING_PAYMENT',
        attemptNumber: 1,
      });
    });

    it('maps a reserved payment to the public pending status', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'pay-reserved',
        status: 'RESERVED',
        amount: 5000,
        currency: 'usd',
        attemptNumber: 1,
        bookingIntent: {
          id: 'intent-123',
          userId: 'user-123',
          status: 'AWAITING_PAYMENT',
        },
      });

      const result = await service.getPaymentStatus('pay-reserved', 'user-123');

      expect(result).toEqual({
        paymentId: 'pay-reserved',
        status: 'PENDING',
        amount: 5000,
        currency: 'usd',
        bookingIntentStatus: 'AWAITING_PAYMENT',
        attemptNumber: 1,
      });
    });
    it('throws NotFoundException when payment does not exist', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce(null);

      await expect(service.getPaymentStatus('non-existent', 'user-123')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when payment belongs to a different user', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        id: 'pay-123',
        status: 'CREATED',
        amount: 5000,
        currency: 'usd',
        attemptNumber: 1,
        bookingIntent: {
          id: 'intent-123',
          userId: 'other-user',
          status: 'AWAITING_PAYMENT',
        },
      });

      await expect(service.getPaymentStatus('pay-123', 'user-123')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
