import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  GoneException,
  InternalServerErrorException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { CreatePaymentDto } from '@/payment/dto/create-payment.dto';
import { PaymentResponseDto } from '@/payment/dto/payment-response.dto';
import { Prisma } from '@prisma/client';
import { toPublicPaymentStatus } from '@shared/types/payment.types';
import { AncillaryPaymentValidationService } from '@/payment/ancillary-payment-validation.service';
import type { ValidatedAncillaryPayment } from '@/payment/ancillary-payment-validation.service';

function majorUnitsToMinorBigInt(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) {
    throw new BadRequestException('Invalid authoritative payment amount');
  }

  const fractional = (match[2] ?? '').padEnd(2, '0');
  return BigInt(match[1]) * 100n + BigInt(fractional || '0');
}

function majorUnitsToMinor(amount: string): number {
  const minor = majorUnitsToMinorBigInt(amount);
  if (minor > 2_147_483_647n) {
    throw new BadRequestException('Authoritative payment amount is too large');
  }

  return parseInt(minor.toString(), 10);
}

function authoritativeAmountsEqual(
  persisted: Prisma.Decimal | string | null,
  validated: string,
): boolean {
  if (persisted === null) {
    return false;
  }

  try {
    return majorUnitsToMinorBigInt(String(persisted)) === majorUnitsToMinorBigInt(validated);
  } catch {
    return false;
  }
}

type PaymentReservation = {
  bookingIntentId: string;
  ancillarySelectionId: string;
  ancillarySelectionVersion: number;
  attemptNumber: number;
  amount: number;
  currency: string;
  validatedAncillary: ValidatedAncillaryPayment;
  intentExpiresAt: string;
  offerExpiresAt: string | null;
  validatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidatedService(value: unknown): value is { serviceId: string; quantity: number } {
  return (
    isRecord(value) && typeof value.serviceId === 'string' && typeof value.quantity === 'number'
  );
}

function readPaymentReservation(
  value: unknown,
  dto: CreatePaymentDto,
): PaymentReservation | undefined {
  if (!isRecord(value) || !isRecord(value.paymentReservation)) {
    return undefined;
  }
  const reservation = value.paymentReservation;
  const validated = reservation.validatedAncillary;
  if (
    typeof reservation.bookingIntentId !== 'string' ||
    reservation.bookingIntentId !== dto.bookingIntentId ||
    typeof reservation.ancillarySelectionId !== 'string' ||
    reservation.ancillarySelectionId !== dto.ancillarySelectionId ||
    typeof reservation.ancillarySelectionVersion !== 'number' ||
    reservation.ancillarySelectionVersion !== dto.ancillarySelectionVersion ||
    typeof reservation.attemptNumber !== 'number' ||
    typeof reservation.amount !== 'number' ||
    typeof reservation.currency !== 'string' ||
    typeof reservation.intentExpiresAt !== 'string' ||
    (reservation.offerExpiresAt !== null && typeof reservation.offerExpiresAt !== 'string') ||
    typeof reservation.validatedAt !== 'string' ||
    !isRecord(validated) ||
    typeof validated.selectionId !== 'string' ||
    validated.selectionId !== dto.ancillarySelectionId ||
    typeof validated.selectionVersion !== 'number' ||
    validated.selectionVersion !== dto.ancillarySelectionVersion ||
    typeof validated.baseAmount !== 'string' ||
    typeof validated.grandTotal !== 'string' ||
    typeof validated.currency !== 'string' ||
    !Array.isArray(validated.services) ||
    !validated.services.every(isValidatedService)
  ) {
    return undefined;
  }

  return {
    bookingIntentId: reservation.bookingIntentId,
    ancillarySelectionId: reservation.ancillarySelectionId,
    ancillarySelectionVersion: reservation.ancillarySelectionVersion,
    attemptNumber: reservation.attemptNumber,
    amount: reservation.amount,
    currency: reservation.currency,
    intentExpiresAt: reservation.intentExpiresAt,
    offerExpiresAt: reservation.offerExpiresAt,
    validatedAt: reservation.validatedAt,
    validatedAncillary: {
      selectionId: validated.selectionId,
      selectionVersion: validated.selectionVersion,
      baseAmount: validated.baseAmount,
      grandTotal: validated.grandTotal,
      currency: validated.currency,
      services: validated.services.map((service) => ({
        serviceId: service.serviceId,
        quantity: service.quantity,
      })),
    },
  };
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly idempotencyService: PaymentIdempotencyService,
    private readonly auditService: AuditService,
    @Optional()
    private readonly ancillaryPaymentValidation?: AncillaryPaymentValidationService,
  ) {}

  /**
   * Core Payment Pipeline: Create & Authorize
   */
  async createPayment(
    dto: CreatePaymentDto,
    idempotencyKey: string,
    userId: string,
    ipAddress: string,
  ): Promise<PaymentResponseDto> {
    let paymentIntent: Awaited<ReturnType<StripeService['createPaymentIntent']>> | undefined =
      undefined;
    let paymentRecord: unknown = null;
    try {
      const requestHash = this.idempotencyService.computeHash(dto);
      const requestPath = '/api/bookings/payment/create';
      let validatedAncillary: ValidatedAncillaryPayment | undefined;
      let recoveredReservation: PaymentReservation | undefined;
      let reuseAttemptNumber: number | undefined;
      let boundPaymentReplay = false;
      if (dto.ancillarySelectionId !== undefined || dto.ancillarySelectionVersion !== undefined) {
        if (dto.ancillarySelectionId === undefined || dto.ancillarySelectionVersion === undefined) {
          throw new BadRequestException(
            'Ancillary selection ID and version must be provided together',
          );
        }
        if (!this.ancillaryPaymentValidation) {
          throw new InternalServerErrorException('Ancillary payment validation is unavailable');
        }
        const boundPayment = await this.prisma.payment?.findFirst({
          where: {
            bookingIntentId: dto.bookingIntentId,
            ancillarySelectionId: dto.ancillarySelectionId,
            ancillarySelectionVersion: dto.ancillarySelectionVersion,
            idempotencyKey: {
              key: idempotencyKey,
              customerId: userId,
            },
          },
          select: {
            bookingIntentId: true,
            ancillarySelectionId: true,
            ancillarySelectionVersion: true,
          },
        });
        boundPaymentReplay =
          boundPayment?.bookingIntentId === dto.bookingIntentId &&
          boundPayment.ancillarySelectionId === dto.ancillarySelectionId &&
          boundPayment.ancillarySelectionVersion === dto.ancillarySelectionVersion;
        if (!boundPaymentReplay) {
          const existingKey = await this.prisma.idempotencyKey?.findUnique({
            where: { key: idempotencyKey },
          });
          if (
            existingKey?.requestHash === requestHash &&
            existingKey.customerId === userId &&
            existingKey.requestPath === requestPath
          ) {
            recoveredReservation = readPaymentReservation(existingKey.requestParams, dto);
          }
          if (recoveredReservation) {
            const nowTime = Date.now();
            const validatedTime = new Date(recoveredReservation.validatedAt).getTime();
            const intentExpiresTime = new Date(recoveredReservation.intentExpiresAt).getTime();
            const offerExpiresTime = recoveredReservation.offerExpiresAt
              ? new Date(recoveredReservation.offerExpiresAt).getTime()
              : null;

            const isStale =
              nowTime - validatedTime > 60_000 ||
              intentExpiresTime <= nowTime ||
              (offerExpiresTime !== null && offerExpiresTime <= nowTime);

            if (isStale) {
              reuseAttemptNumber = recoveredReservation.attemptNumber;
              recoveredReservation = undefined;
            }
          }
          if (!recoveredReservation) {
            validatedAncillary = await this.ancillaryPaymentValidation.validateForPayment({
              userId,
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: dto.ancillarySelectionId,
              ancillarySelectionVersion: dto.ancillarySelectionVersion,
            });
          }
        }
      }

      // 1. Check/acquire the request idempotency key
      const idempotency = await this.idempotencyService.acquireOrReplay(
        idempotencyKey,
        requestHash,
        userId,
        requestPath,
      );

      if (idempotency.status === 'replay') {
        return JSON.parse(idempotency.responseBody);
      }

      if (recoveredReservation) {
        const acquiredKey = await this.prisma.idempotencyKey.findUnique({
          where: { key: idempotencyKey },
        });
        if (
          acquiredKey?.requestHash !== requestHash ||
          acquiredKey.customerId !== userId ||
          acquiredKey.requestPath !== requestPath
        ) {
          throw new ConflictException('Payment reservation is no longer available');
        }
        recoveredReservation = readPaymentReservation(acquiredKey.requestParams, dto);
        if (!recoveredReservation) {
          throw new ConflictException('Payment reservation is no longer available');
        }
        validatedAncillary = recoveredReservation.validatedAncillary;
      }

      // 2. Lock & update BookingIntent paymentAttemptCount inside transaction
      const intent = await this.prisma.bookingIntent.findUnique({
        where: { id: dto.bookingIntentId },
        select: {
          id: true,
          status: true,
          paymentAttemptCount: true,
          confirmedPrice: true,
          currency: true,
          userId: true,
          currentAncillarySelectionId: true,
          ancillaryVersion: true,
        },
      });

      if (!intent) {
        throw new NotFoundException('Booking intent not found');
      }

      if (intent.userId !== userId) {
        throw new ForbiddenException('You do not own this booking intent');
      }

      if (intent.status !== 'PENDING' && intent.status !== 'AWAITING_PAYMENT') {
        throw new BadRequestException('Booking intent is not in an allowed status for payment');
      }

      const targetAncillarySelectionId =
        dto.ancillarySelectionId || intent.currentAncillarySelectionId;
      const targetAncillarySelectionVersion =
        dto.ancillarySelectionVersion ?? intent.ancillaryVersion;

      let validated: Awaited<
        ReturnType<AncillaryPaymentValidationService['validateForPayment']>
      > | null = null;
      let amountInCents: number;

      if (
        targetAncillarySelectionId &&
        targetAncillarySelectionVersion !== null &&
        targetAncillarySelectionVersion !== undefined &&
        targetAncillarySelectionVersion > 0
      ) {
        if (
          validatedAncillary &&
          validatedAncillary.selectionId === targetAncillarySelectionId &&
          validatedAncillary.selectionVersion === targetAncillarySelectionVersion
        ) {
          validated = validatedAncillary;
        } else if (!boundPaymentReplay) {
          if (!this.ancillaryPaymentValidation) {
            throw new BadRequestException('Ancillary payment validation service is not available');
          }
          validated = await this.ancillaryPaymentValidation.validateForPayment({
            userId,
            bookingIntentId: dto.bookingIntentId,
            ancillarySelectionId: targetAncillarySelectionId,
            ancillarySelectionVersion: targetAncillarySelectionVersion,
          });
        }
        if (validated) {
          amountInCents = Math.round(Number(validated.grandTotal) * 100);
        } else {
          amountInCents = 0; // Will be set from existing payment
        }
      } else {
        amountInCents = Math.round(Number(intent.confirmedPrice) * 100);
      }

      const result = await this.prisma.$transaction(async (tx) => {
        interface RawBookingIntent {
          id: string;
          status: string;
          paymentAttemptCount: number;
          confirmedPrice: Prisma.Decimal | string;
          currency: string;
          userId: string;
          currentAncillarySelectionId: string | null;
          ancillaryVersion: number;
          intentExpiresAt: Date;
          offerExpiresAt: Date | null;
        }

        const intents = await tx.$queryRaw<RawBookingIntent[]>`
          SELECT id, status, "paymentAttemptCount", "confirmedPrice", currency, "userId",
                 "currentAncillarySelectionId", "ancillaryVersion", "intentExpiresAt", "offerExpiresAt"
          FROM booking_intents
          WHERE id = ${dto.bookingIntentId}
          FOR UPDATE
        `;

        if (intents.length === 0) {
          throw new NotFoundException('Booking intent not found');
        }

        const txIntent = intents[0];
        if (txIntent.userId !== userId) {
          throw new ForbiddenException('You do not own this booking intent');
        }

        const now = new Date();
        if (txIntent.intentExpiresAt && new Date(txIntent.intentExpiresAt) <= now) {
          throw new GoneException('Booking intent has expired');
        }
        if (txIntent.offerExpiresAt && new Date(txIntent.offerExpiresAt) <= now) {
          throw new GoneException('Offer has expired');
        }

        if (!dto.ancillarySelectionId && txIntent.currentAncillarySelectionId) {
          const seatCount = await tx.seatSelection.count({
            where: { ancillarySelectionId: txIntent.currentAncillarySelectionId },
          });
          const baggageCount = await tx.baggageSelection.count({
            where: { ancillarySelectionId: txIntent.currentAncillarySelectionId },
          });
          if (seatCount > 0 || baggageCount > 0) {
            throw new BadRequestException(
              'Ancillary selections exist but were not included in the payment request',
            );
          }
        }

        if (
          (validatedAncillary &&
            txIntent.status !== 'PENDING' &&
            !(recoveredReservation && txIntent.status === 'AWAITING_PAYMENT')) ||
          (!validatedAncillary &&
            txIntent.status !== 'PENDING' &&
            txIntent.status !== 'AWAITING_PAYMENT')
        ) {
          throw new BadRequestException('Booking intent is not in an allowed status for payment');
        }

        const existingPayment = await tx.payment.findFirst({
          where: {
            idempotencyKey: {
              key: idempotencyKey,
            },
          },
        });

        if (existingPayment) {
          return {
            amount: existingPayment.amount,
            currency: existingPayment.currency.toUpperCase(),
            attemptNumber: existingPayment.attemptNumber,
            payment: existingPayment,
          };
        }

        if (!recoveredReservation && txIntent.paymentAttemptCount >= 2) {
          throw new BadRequestException('Payment attempts exhausted');
        }

        const nextAttemptCount =
          recoveredReservation?.attemptNumber ??
          reuseAttemptNumber ??
          txIntent.paymentAttemptCount + 1;
        const amount =
          recoveredReservation?.amount ??
          (validatedAncillary
            ? majorUnitsToMinor(validatedAncillary.grandTotal)
            : majorUnitsToMinor(String(txIntent.confirmedPrice)));
        const currency =
          recoveredReservation?.currency ?? validatedAncillary?.currency ?? txIntent.currency;
        if (validatedAncillary) {
          if (
            txIntent.currentAncillarySelectionId !== validatedAncillary.selectionId ||
            txIntent.ancillaryVersion !== validatedAncillary.selectionVersion
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: txIntent.ancillaryVersion,
            });
          }
          if (txIntent.currency.toUpperCase() !== validatedAncillary.currency.toUpperCase()) {
            throw new BadRequestException({
              code: 'ANCILLARY_CURRENCY_MISMATCH',
              intentId: dto.bookingIntentId,
            });
          }
          interface RawAncillarySelection {
            id: string;
            status: string;
            currency: string;
            validatedBaseAmount: Prisma.Decimal | string | null;
            validatedGrandTotal: Prisma.Decimal | string | null;
            validationLeaseToken: string | null;
            validationLeaseExpiresAt: Date | null;
            validatedAt: Date | null;
          }
          const selections = await tx.$queryRaw<RawAncillarySelection[]>`
            SELECT id, status, currency, "validatedBaseAmount", "validatedGrandTotal",
                   "validationLeaseToken", "validationLeaseExpiresAt", "validatedAt"
            FROM ancillary_selections
            WHERE id = ${validatedAncillary.selectionId}
              AND "bookingIntentId" = ${dto.bookingIntentId}
              AND version = ${validatedAncillary.selectionVersion}
            FOR UPDATE
          `;
          const selection = selections[0];
          const validatedAtTime = selection?.validatedAt
            ? new Date(selection.validatedAt).getTime()
            : 0;
          if (
            selections.length !== 1 ||
            selection.status !== 'VALIDATED' ||
            Date.now() - validatedAtTime > 60_000 ||
            selection.currency.toUpperCase() !== validatedAncillary.currency.toUpperCase() ||
            !authoritativeAmountsEqual(
              selection.validatedBaseAmount,
              validatedAncillary.baseAmount,
            ) ||
            !authoritativeAmountsEqual(
              selection.validatedGrandTotal,
              validatedAncillary.grandTotal,
            ) ||
            selection.validationLeaseToken !== null ||
            selection.validationLeaseExpiresAt !== null
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: txIntent.ancillaryVersion,
            });
          }

          if (!recoveredReservation) {
            const reservation: PaymentReservation = {
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: validatedAncillary.selectionId,
              ancillarySelectionVersion: validatedAncillary.selectionVersion,
              attemptNumber: nextAttemptCount,
              amount,
              currency,
              validatedAncillary,
              intentExpiresAt: txIntent.intentExpiresAt
                ? new Date(txIntent.intentExpiresAt).toISOString()
                : new Date(Date.now() + 600000).toISOString(),
              offerExpiresAt: txIntent.offerExpiresAt
                ? new Date(txIntent.offerExpiresAt).toISOString()
                : null,
              validatedAt: selection.validatedAt
                ? new Date(selection.validatedAt).toISOString()
                : new Date().toISOString(),
            };
            const reserved = await tx.$executeRaw`
              WITH reserved_key AS (
                UPDATE idempotency_keys
                SET "requestParams" = jsonb_build_object(
                  'paymentReservation',
                  ${reservation}::jsonb
                )
                WHERE "key" = ${idempotencyKey}
                  AND "requestHash" = ${requestHash}
                  AND "customerId" = ${userId}
                  AND "requestPath" = ${requestPath}
                  AND "lockedAt" = ${idempotency.lockedAt}
                RETURNING id
              )
              UPDATE booking_intents
              SET "paymentAttemptCount" = ${nextAttemptCount}, status = 'AWAITING_PAYMENT'
              WHERE id = ${dto.bookingIntentId}
                AND EXISTS (SELECT 1 FROM reserved_key)
            `;
            if (reserved !== 1) {
              throw new ConflictException('Payment reservation ownership was lost');
            }
          }
        } else {
          if (!recoveredReservation) {
            await tx.$executeRaw`
              UPDATE booking_intents
              SET "paymentAttemptCount" = ${nextAttemptCount}, status = 'AWAITING_PAYMENT'
              WHERE id = ${dto.bookingIntentId}
            `;
          }
        }

        if (validated) {
          if (
            txIntent.currentAncillarySelectionId !== validated.selectionId ||
            txIntent.ancillaryVersion !== validated.selectionVersion
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: txIntent.ancillaryVersion,
              message:
                'Ancillary selection was updated after validation. Please revalidate before payment.',
            });
          }
        }

        return {
          amount,
          currency,
          attemptNumber: nextAttemptCount,
        };
      });

      // 3. Lazy create Stripe Customer
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, stripeCustomerId: true },
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      let stripeCustomerId = user.stripeCustomerId;
      if (!stripeCustomerId) {
        const customer = await this.stripeService.createCustomer(
          user.email,
          undefined,
          `customer-create:${userId}`,
        );
        stripeCustomerId = customer.id;

        const updateResult = await this.prisma.user.updateMany({
          where: {
            id: userId,
            stripeCustomerId: null,
          },
          data: {
            stripeCustomerId,
          },
        });

        if (updateResult.count === 0) {
          const refreshedUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeCustomerId: true },
          });
          stripeCustomerId = refreshedUser?.stripeCustomerId || stripeCustomerId;
        }
      }

      // 4. Create Stripe PaymentIntent
      amountInCents = result.amount;
      const stripeMetadata: Record<string, string> =
        validatedAncillary || boundPaymentReplay
          ? {
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: validatedAncillary?.selectionId ?? dto.ancillarySelectionId!,
              ancillarySelectionVersion: String(
                validatedAncillary?.selectionVersion ?? dto.ancillarySelectionVersion,
              ),
            }
          : { bookingIntentId: dto.bookingIntentId };
      paymentIntent = await this.stripeService.createPaymentIntent(
        amountInCents,
        result.currency,
        stripeCustomerId,
        stripeMetadata,
        `${idempotencyKey}-stripe-intent`,
        dto.paymentMethodId,
        dto.saveCard ? 'off_session' : undefined,
      );

      // 5. Create Payment record in DB
      let payment;
      if (validatedAncillary) {
        payment = await this.prisma.$transaction(async (tx) => {
          interface ShortBookingIntent {
            currentAncillarySelectionId: string | null;
            ancillaryVersion: number | null;
          }
          const lockedIntents = await tx.$queryRaw<ShortBookingIntent[]>`
            SELECT "currentAncillarySelectionId", "ancillaryVersion"
            FROM booking_intents
            WHERE id = ${dto.bookingIntentId}
            FOR UPDATE
          `;
          const lockedIntent = lockedIntents[0];
          if (
            !lockedIntent ||
            lockedIntent.currentAncillarySelectionId !== validatedAncillary.selectionId ||
            lockedIntent.ancillaryVersion !== validatedAncillary.selectionVersion
          ) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: lockedIntent?.ancillaryVersion ?? 0,
            });
          }
          const existingPayment = await tx.payment.findFirst({
            where: {
              idempotencyKey: { key: idempotencyKey },
            },
          });
          if (existingPayment) {
            return existingPayment;
          }

          const bound = await tx.ancillarySelection.updateMany({
            where: {
              id: validatedAncillary.selectionId,
              bookingIntentId: dto.bookingIntentId,
              version: validatedAncillary.selectionVersion,
              status: 'VALIDATED',
              currency: validatedAncillary.currency,
              validatedBaseAmount: validatedAncillary.baseAmount,
              validatedGrandTotal: validatedAncillary.grandTotal,
            },
            data: { status: 'PAYMENT_BOUND' },
          });
          if (bound.count !== 1) {
            throw new ConflictException({
              code: 'ANCILLARY_VERSION_CONFLICT',
              intentId: dto.bookingIntentId,
              currentVersion: validatedAncillary.selectionVersion,
            });
          }

          const keyRecord = await tx.idempotencyKey.findUnique({
            where: { key: idempotencyKey },
            select: { id: true },
          });
          if (!keyRecord) {
            throw new InternalServerErrorException('Idempotency key record not found');
          }

          const created = await tx.payment.create({
            data: {
              bookingIntentId: dto.bookingIntentId,
              ancillarySelectionId: validatedAncillary.selectionId,
              ancillarySelectionVersion: validatedAncillary.selectionVersion,
              attemptNumber: result.attemptNumber,
              idempotencyKeyId: keyRecord.id,
              stripePaymentIntentId: paymentIntent!.id,
              stripeCustomerId,
              amount: amountInCents,
              currency: result.currency.toLowerCase(),
              status: 'CREATED',
            },
          });

          const eventTx = tx.paymentEvent ? tx : this.prisma;
          await eventTx.paymentEvent.create({
            data: {
              paymentId: created.id,
              eventType: 'payment_created',
              previousStatus: 'CREATED',
              newStatus: 'CREATED',
              amount: amountInCents,
              source: 'API',
              createdBy: userId,
              metadata: {
                bookingIntentId: dto.bookingIntentId,
                ancillarySelectionId: validatedAncillary.selectionId,
                ancillarySelectionVersion: validatedAncillary.selectionVersion,
                serviceCount: validatedAncillary.services.length,
                serviceQuantity: validatedAncillary.services.reduce(
                  (total, service) => total + service.quantity,
                  0,
                ),
                baseAmount: validatedAncillary.baseAmount,
                grandTotal: validatedAncillary.grandTotal,
                currency: validatedAncillary.currency,
              },
            },
          });

          await this.auditService.createLog(tx, {
            userId,
            action: 'payment_created',
            resourceType: 'Payment',
            resourceId: created.id,
            ipAddress,
            metadata: {
              bookingIntentId: dto.bookingIntentId,
              amount: amountInCents,
              attemptNumber: result.attemptNumber,
              ancillarySelectionId: validatedAncillary.selectionId,
              ancillarySelectionVersion: validatedAncillary.selectionVersion,
              serviceCount: validatedAncillary.services.length,
              serviceQuantity: validatedAncillary.services.reduce(
                (total, service) => total + service.quantity,
                0,
              ),
              baseAmount: validatedAncillary.baseAmount,
              grandTotal: validatedAncillary.grandTotal,
              currency: validatedAncillary.currency,
            },
          });

          return created;
        });
      } else if ('payment' in result && result.payment) {
        payment = result.payment;
      } else {
        payment = await this.prisma.$transaction(async (tx) => {
          const keyRecord = await tx.idempotencyKey.findUnique({
            where: { key: idempotencyKey },
            select: { id: true },
          });
          if (!keyRecord) {
            throw new InternalServerErrorException('Idempotency key record not found');
          }

          const existingPayment = await tx.payment.findFirst({
            where: {
              idempotencyKeyId: keyRecord.id,
            },
          });

          if (existingPayment) {
            return existingPayment;
          }

          const created = await tx.payment.create({
            data: {
              bookingIntentId: dto.bookingIntentId,
              attemptNumber: result.attemptNumber,
              idempotencyKeyId: keyRecord.id,
              stripePaymentIntentId: paymentIntent!.id,
              stripeCustomerId,
              amount: amountInCents,
              currency: result.currency.toLowerCase(),
              status: 'CREATED',
            },
          });

          const eventTx = tx.paymentEvent ? tx : this.prisma;
          await eventTx.paymentEvent.create({
            data: {
              paymentId: created.id,
              eventType: 'payment_created',
              previousStatus: 'CREATED',
              newStatus: 'CREATED',
              amount: amountInCents,
              source: 'API',
              createdBy: userId,
            },
          });

          await this.auditService.createLog(tx, {
            userId,
            action: 'payment_created',
            resourceType: 'Payment',
            resourceId: created.id,
            ipAddress,
            metadata: {
              bookingIntentId: dto.bookingIntentId,
              amount: amountInCents,
              attemptNumber: result.attemptNumber,
            },
          });

          return created;
        });
      }

      paymentRecord = payment;

      // 7. Update recovery point and complete idempotency key
      await this.idempotencyService.updateRecoveryPoint(idempotencyKey, 'started');

      const responseBody = {
        paymentId: payment.id,
        clientSecret: paymentIntent.client_secret || '',
        status: payment.status,
      };

      await this.idempotencyService.completeKey(idempotencyKey, HttpStatus.CREATED, responseBody);

      return responseBody;
    } catch (error) {
      if (paymentIntent?.id && !paymentRecord) {
        try {
          await this.stripeService.cancelPaymentIntent(paymentIntent.id);
        } catch (cancelErr) {
          this.logger.error(
            `Failed to cancel Stripe PaymentIntent ${paymentIntent.id} after createPayment error: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
          );
        }
      }
      this.logger.error(
        `Error in createPayment: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Retrieve payment and booking status
   */
  async getPaymentStatus(paymentId: string, userId: string): Promise<unknown> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { bookingIntent: true },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.bookingIntent.userId !== userId) {
      throw new ForbiddenException('You do not own this payment');
    }

    return {
      paymentId: payment.id,
      status: toPublicPaymentStatus(payment.status),
      amount: payment.amount,
      currency: payment.currency,
      bookingIntentStatus: payment.bookingIntent.status,
      attemptNumber: payment.attemptNumber,
    };
  }
}

