import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BookingFailureReason, PaymentStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import {
  PaymentIdempotencyService,
  SagaOwnership,
} from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingPassengerFinalValidatorService } from '@/booking-intent/booking-passenger-final-validator.service';
import { AuditService } from '@/audit/audit.service';
import { BookingEventPublisherService, TransactionEventContext } from '@/domain-events';
import { ConfirmPaymentDto } from '@/payment/dto/confirm-payment.dto';
import { enforceTransition } from '@/payment/payment-state-machine';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { FLIGHT_SEARCH_PORT } from '@/supplier/search/flight-search.port';
import type { FlightSearchPort } from '@/supplier/search/flight-search.port';
import {
  PAYMENT_GATEWAY_PORT,
  FULFILLMENT_GATEWAY_PORT,
  PaymentGatewayPort,
  FulfillmentGatewayPort,
  CancelOrderOutcome,
  PortInvocationControl,
  AuthorizeHoldOutcome,
  PassengerEnrichmentInput,
  PersistedOrderEvidence,
  EphemeralPassenger,
  CapturePaymentOutcome,
} from './ports';

function isOwnershipLost(error: unknown): boolean {
  return error instanceof ConflictException && error.message.includes('ownership');
}

function readOrderId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if ('id' in value && typeof value.id === 'string' && value.id.trim().length > 0) {
    return value.id;
  }
  if (!('data' in value) || typeof value.data !== 'object' || value.data === null) {
    return undefined;
  }
  return 'id' in value.data && typeof value.data.id === 'string' &&
    value.data.id.trim().length > 0 ? value.data.id : undefined;
}

function isCancellationConfirmed(outcome: CancelOrderOutcome): boolean {
  if (!outcome.success) {
    return false;
  }
  if (outcome.status === undefined) {
    return true;
  }
  const upper = outcome.status.toUpperCase();
  return upper === 'CANCELLED' || upper === 'CONFIRMED' || upper === 'CANCELED';
}

@Injectable()
export class PaymentFulfillmentSaga {
  private readonly logger = new Logger(PaymentFulfillmentSaga.name);
  public timeoutMs = 25000;

  constructor(
    @Inject(PAYMENT_GATEWAY_PORT)
    private readonly paymentGateway: PaymentGatewayPort,
    @Inject(FULFILLMENT_GATEWAY_PORT)
    private readonly fulfillmentGateway: FulfillmentGatewayPort,
    private readonly idempotency: PaymentIdempotencyService,
    private readonly paymentMethodService: PaymentMethodService,
    private readonly bookingLifecycleService: BookingLifecycleService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(FLIGHT_SEARCH_PORT)
    private readonly flightSearchPort: FlightSearchPort,
    @Optional()
    private readonly bookingPassengerFinalValidator?: BookingPassengerFinalValidatorService,
    @Optional()
    private readonly publisher?: BookingEventPublisherService,
  ) {}

  async confirmPayment(
    dto: ConfirmPaymentDto,
    idempotencyKey: string,
    userId: string,
    traceContext?: { traceId?: string; correlationId?: string },
  ): Promise<unknown> {
    const requestHash = this.idempotency.computeHash(dto);
    const idempotency = await this.idempotency.acquireOrReplay(
      idempotencyKey,
      requestHash,
      userId,
      '/api/bookings/payment/confirm',
    );

    if (idempotency.status === 'replay') {
      try {
        return JSON.parse(idempotency.responseBody);
      } catch {
        return idempotency.responseBody;
      }
    }

    const ownership: SagaOwnership = {
      key: idempotencyKey,
      userId,
      requestPath: '/api/bookings/payment/confirm',
      requestHash,
      lockedAt: idempotency.lockedAt,
    };

    let isFinished = false;
    const confirmPromise = (async () => {
      try {
        const result = await this.executeConfirmPayment(
          dto,
          idempotencyKey,
          userId,
          ownership,
          traceContext,
        );
        isFinished = true;
        return result;
      } catch (error) {
        isFinished = true;
        throw error;
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
      timer = setTimeout(() => resolve({ isTimeout: true }), this.timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    try {
      const raceResult = await Promise.race([confirmPromise, timeoutPromise]);

      if (
        raceResult &&
        typeof raceResult === 'object' &&
        'isTimeout' in raceResult &&
        (raceResult as { isTimeout: boolean }).isTimeout &&
        !isFinished
      ) {
        this.logger.log('[confirmPayment] Hit Tier 2 timeout (25s). Handoff to async polling.');

        confirmPromise.catch((err: unknown) => {
          this.logger.error(
            `[confirmPayment] Background execution failed for payment ${dto.paymentId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            err instanceof Error ? err.stack : undefined,
          );
          this.handleBackgroundError(
            dto.paymentId,
            idempotencyKey,
            userId,
            ownership,
            err,
          ).catch((bgErr: unknown) => {
            this.logger.error(
              `[confirmPayment] Failed to execute background error recovery: ${
                bgErr instanceof Error ? bgErr.message : String(bgErr)
              }`,
              bgErr instanceof Error ? bgErr.stack : undefined,
            );
          });
        });

        return {
          status: 'PENDING',
          message: 'Booking is being confirmed. Please poll status.',
          pollUrl: `/api/bookings/payment/${dto.paymentId}/status`,
        };
      }

      if (timer) {
        clearTimeout(timer);
      }
      return raceResult;
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      throw error;
    }
  }

  async executeConfirmPayment(
    dto: ConfirmPaymentDto,
    idempotencyKey: string,
    userId: string,
    ownership?: SagaOwnership,
    traceContext?: { traceId?: string; correlationId?: string },
  ): Promise<unknown> {
    if (!ownership) {
      const requestHash = this.idempotency.computeHash(dto);
      const idempotency = await this.idempotency.acquireOrReplay(
        idempotencyKey,
        requestHash,
        userId,
        '/api/bookings/payment/confirm',
      );

      if (idempotency.status === 'replay') {
        try {
          return JSON.parse(idempotency.responseBody);
        } catch {
          return idempotency.responseBody;
        }
      }

      ownership = {
        key: idempotencyKey,
        userId,
        requestPath: '/api/bookings/payment/confirm',
        requestHash,
        lockedAt: idempotency.lockedAt,
      };
    }

    const currentOwnership = ownership;
    const control: PortInvocationControl = {
      beforeInvoke: () => this.idempotency.assertOwned(currentOwnership),
    };

    try {
      let payment = await this.prisma.payment.findUnique({
        where: { id: dto.paymentId },
        include: {
          bookingIntent: true,
          ancillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: {
                include: {
                  segments: true,
                },
              },
            },
          },
        },
      });

      if (!payment) {
        throw new NotFoundException('Payment record not found');
      }

      if (payment.bookingIntent.userId !== userId) {
        throw new ForbiddenException('You do not own this payment');
      }

      if (dto.bookingId && typeof this.prisma.booking?.findUnique === 'function') {
        const requestedBooking = await this.prisma.booking.findUnique({
          where: { id: dto.bookingId },
        });
        if (requestedBooking && requestedBooking.userId !== userId) {
          throw new ForbiddenException('You do not own this booking');
        }
      }

      const flightSnapshot = this.flightSearchPort.normalizeStoredFlightSnapshot(
        payment.bookingIntent.rawOfferSnapshot,
      );
      const canonicalBooking = await this.bookingLifecycleService.createBooking(
        userId,
        dto.bookingId,
        payment.bookingIntentId,
        payment.id,
        undefined,
        flightSnapshot ?? undefined,
      );

      if (canonicalBooking.userId !== userId) {
        throw new ForbiddenException('You do not own this booking');
      }

      let recoveryPoint = await this.idempotency.getResumePoint(idempotencyKey);
      if (!recoveryPoint) {
        recoveryPoint = 'started';
      }

      if (recoveryPoint === 'completed') {
        if (payment.status === 'SUCCEEDED') {
          const duffelEvent = await this.prisma.paymentEvent.findFirst({
            where: {
              paymentId: payment.id,
              eventType: 'duffel_order_created',
            },
            orderBy: { createdAt: 'desc' },
          });

          // Metadata stored in paymentEvent is a Prisma Json object containing the order details
          const duffelOrder = duffelEvent?.metadata as Record<string, unknown> | null;
          if (!duffelOrder) {
            throw new InternalServerErrorException(
              'Duffel order details not found in payment history.',
            );
          }

          const successResponse = {
            success: true,
            paymentId: payment.id,
            status: 'SUCCEEDED',
            bookingReference: (duffelOrder.bookingReference ||
              duffelOrder.booking_reference) as string,
            duffelOrderId: duffelOrder.id as string,
          };

          await this.idempotency.completeSagaKeyAtomic(
            currentOwnership,
            HttpStatus.OK,
            successResponse,
          );
          return successResponse;
        } else {
          const duffelEvent = await this.prisma.paymentEvent.findFirst({
            where: {
              paymentId: payment.id,
              eventType: 'duffel_order_created',
            },
            orderBy: { createdAt: 'desc' },
          });

          const errorMsg = duffelEvent
            ? 'Stripe capture failed or background processing failed. Duffel order cancelled and hold released.'
            : 'Duffel booking failed. Payment hold released.';

          const bookingIntent = await this.prisma.bookingIntent.findUnique({
            where: { id: payment.bookingIntentId },
          });

          const failureResponse = {
            success: false,
            error: errorMsg,
            bookingStatus: bookingIntent?.status || 'CANCELLED',
          };

          await this.idempotency.completeSagaKeyAtomic(
            currentOwnership,
            HttpStatus.BAD_GATEWAY,
            failureResponse,
          );
          return failureResponse;
        }
      }

      if (recoveryPoint === 'started') {
        const authOutcome = await this.paymentGateway.authorizeHold(
          payment.stripePaymentIntentId,
          control,
        );

        if (authOutcome.status === 'authorized') {
          if (payment.status === 'CREATED') {
            enforceTransition(payment.status, 'AUTHORIZED');
            await this.idempotency.assertOwned(currentOwnership);

            const paymentId = payment.id;
            const previousStatus = payment.status;
            const authorizedAmount = payment.amount;

            await this.prisma.$transaction(async (tx) => {
              const updateResult = await tx.payment.updateMany({
                where: { id: paymentId, status: 'CREATED' },
                data: { status: 'AUTHORIZED' },
              });
              if (updateResult.count === 0) {
                throw new ConflictException(
                  `Payment ${paymentId} status is no longer CREATED; cannot transition to AUTHORIZED`,
                );
              }
              await tx.paymentEvent.create({
                data: {
                  paymentId,
                  eventType: 'payment_authorized',
                  previousStatus,
                  newStatus: 'AUTHORIZED',
                  amount: authorizedAmount,
                  source: 'API',
                  createdBy: userId,
                },
              });
            });

            payment = { ...payment, status: 'AUTHORIZED' };

            await this.auditService.createLog(this.prisma, {
              userId,
              action: 'payment_authorized',
              resourceType: 'Payment',
              resourceId: payment.id,
              metadata: { stripePaymentIntentId: payment.stripePaymentIntentId },
            });
          }
        } else if (authOutcome.status !== 'captured') {
          throw new BadRequestException(
            `Stripe PaymentIntent is in invalid status: ${
              authOutcome.rawStatus || authOutcome.status
            }`,
          );
        }

        await this.idempotency.advanceSagaCheckpoint(currentOwnership, 'stripe_authorized');
        recoveryPoint = 'stripe_authorized';
      }

      if (recoveryPoint === 'stripe_authorized') {
        const bookingIntent = await this.prisma.bookingIntent.findUnique({
          where: { id: payment.bookingIntentId },
          include: { passengers: true },
        });

        if (!bookingIntent) {
          throw new NotFoundException('Booking intent not found');
        }

        const servicesMap = new Map<string, number>();
        if (payment.ancillarySelection) {
          for (const seat of payment.ancillarySelection.seatSelections) {
            servicesMap.set(seat.serviceId, (servicesMap.get(seat.serviceId) ?? 0) + 1);
          }
          for (const baggage of payment.ancillarySelection.baggageSelections) {
            servicesMap.set(
              baggage.serviceId,
              (servicesMap.get(baggage.serviceId) ?? 0) + baggage.quantity,
            );
          }
        }
        const services = Array.from(servicesMap.entries()).map(([serviceId, quantity]) => ({
          serviceId,
          quantity,
        }));

        let passengersToOrder: EphemeralPassenger[];
        if (this.bookingPassengerFinalValidator) {
          try {
            const ephemeralPassengers =
              this.bookingPassengerFinalValidator.validateAndMapPassengers(bookingIntent, {
                traceId: traceContext?.traceId,
                correlationId: traceContext?.correlationId,
              });
            passengersToOrder = ephemeralPassengers;

            await this.auditService.createLog(this.prisma, {
              userId,
              action: 'final_passenger_validation_succeeded',
              resourceType: 'BookingIntent',
              resourceId: bookingIntent.id,
              metadata: {
                paymentId: payment.id,
                passengerCount: bookingIntent.passengers.length,
              },
              traceId: traceContext?.traceId,
              correlationId: traceContext?.correlationId,
            });
          } catch (validationError: unknown) {
            const error = validationError as Error;
            const responseObj =
              validationError instanceof HttpException
                ? (validationError.getResponse() as Record<string, unknown> | string)
                : null;
            const reasonCode =
              typeof responseObj === 'object' && responseObj !== null && 'code' in responseObj
                ? (responseObj as { code: string }).code
                : 'FINAL_PASSENGER_VALIDATION_FAILED';
            const status =
              validationError instanceof HttpException
                ? validationError.getStatus()
                : HttpStatus.UNPROCESSABLE_ENTITY;

            this.logger.error(
              `[executeConfirmPayment] Final passenger validation failed for booking intent ${bookingIntent.id}: ${error.message}`,
              error.stack,
            );

            await this.auditService.createLog(this.prisma, {
              userId,
              action: 'final_passenger_validation_failed',
              resourceType: 'BookingIntent',
              resourceId: bookingIntent.id,
              metadata: {
                reasonCode,
                intentId: bookingIntent.id,
                paymentId: payment.id,
                passengerCount: bookingIntent.passengers.length,
              },
              traceId: traceContext?.traceId,
              correlationId: traceContext?.correlationId,
            });

            try {
              await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
            } catch (voidError: unknown) {
              if (isOwnershipLost(voidError)) {
                throw voidError;
              }
              const voidErr = voidError as Error;
              this.logger.error(
                `[executeConfirmPayment] Payment gateway voidHold failed after passenger validation error: ${voidErr.message}`,
                voidErr.stack,
              );
            }

            const previousPaymentStatus = payment.status;
            enforceTransition(previousPaymentStatus, 'CANCELLED');
            const nextBookingStatus =
              bookingIntent.paymentAttemptCount < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

            let eventContext: TransactionEventContext | undefined;
            await this.prisma.$transaction(async (tx) => {
              eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
              await tx.payment.update({
                where: { id: payment.id },
                data: { status: 'CANCELLED' },
              });
              await tx.paymentEvent.create({
                data: {
                  paymentId: payment.id,
                  eventType: 'payment_cancelled',
                  previousStatus: previousPaymentStatus,
                  newStatus: 'CANCELLED',
                  amount: payment.amount,
                  source: 'API',
                  createdBy: userId,
                },
              });
              await tx.bookingIntent.update({
                where: { id: bookingIntent.id },
                data: { status: nextBookingStatus },
              });
              await this.bookingLifecycleService.updateToFailed(
                canonicalBooking.id,
                BookingFailureReason.SYSTEM_ERROR,
                undefined,
                undefined,
                undefined,
                tx,
                eventContext,
              );
            });
            if (eventContext && eventContext.events.length > 0 && this.publisher) {
              await this.publisher.publish(eventContext.events);
            }

            const failureResponse = {
              success: false,
              error: `Passenger validation failed: ${
                typeof responseObj === 'object' && responseObj !== null && 'message' in responseObj
                  ? responseObj.message
                  : error.message || 'Validation failed'
              }. Payment hold released.`,
              code: reasonCode,
              bookingStatus: nextBookingStatus,
            };
            await this.idempotency.completeSagaKeyAtomic(
              currentOwnership,
              status,
              failureResponse,
            );

            throw new HttpException(failureResponse, status);
          }
        } else {
          passengersToOrder = bookingIntent.passengers.map((p) => {
            const mapped: EphemeralPassenger = {
              id: p.id,
              givenName: p.givenName ?? undefined,
              familyName: p.familyName ?? undefined,
              title: p.title ?? undefined,
              email: p.email ?? undefined,
              phoneNumber: p.phoneNumber ?? undefined,
              type: p.type ?? undefined,
              dateOfBirth: p.dateOfBirth ?? undefined,
              gender: p.gender ?? undefined,
              middleName: p.middleName ?? undefined,
              phoneCountryCode: p.phoneCountryCode ?? undefined,
              nationality: p.nationality ?? undefined,
              passportNumber: p.passportNumber ?? undefined,
              passportExpiry: p.passportExpiry ?? undefined,
              travelerProfileId: p.travelerProfileId ?? undefined,
              duffelPassengerId: p.supplierPassengerId ?? undefined,
              documentType: p.documentType ?? undefined,
              issuingCountry: p.issuingCountry ?? undefined,
            };
            return mapped;
          });
        }

        const recheckedPayment = await this.prisma.payment.findUnique({
          where: { id: payment.id },
          include: {
            bookingIntent: true,
            ancillarySelection: {
              include: {
                seatSelections: true,
                baggageSelections: true,
              },
            },
          },
        });

        if (!recheckedPayment) {
          throw new InternalServerErrorException(
            'Payment-bound ancillary selection could not be recovered',
          );
        }

        const orderPayment = recheckedPayment;
        const hasAncillaryBinding = payment.ancillarySelectionId !== null;
        const hasExactBoundSelection =
          orderPayment.ancillarySelectionId === payment.ancillarySelectionId &&
          orderPayment.ancillarySelectionVersion === payment.ancillarySelectionVersion &&
          (hasAncillaryBinding
            ? orderPayment.ancillarySelection?.id === payment.ancillarySelectionId &&
              orderPayment.ancillarySelection.version === payment.ancillarySelectionVersion &&
              orderPayment.ancillarySelection.status === 'PAYMENT_BOUND'
            : orderPayment.ancillarySelection === null);

        if (!hasExactBoundSelection) {
          throw new InternalServerErrorException(
            'Payment-bound ancillary selection could not be recovered',
          );
        }

        let orderOutcome: Awaited<ReturnType<FulfillmentGatewayPort['createOrder']>>;
        try {
          orderOutcome = await this.fulfillmentGateway.createOrder(
            {
              offerId: bookingIntent.supplierOfferId,
              passengers: passengersToOrder,
              services: services.length > 0 ? services : undefined,
              metadata: {
                bookingIntentId: bookingIntent.id,
                paymentId: payment.id,
              },
              idempotencyKey,
            },
            control,
          );
        } catch (fulfillmentError: unknown) {
          if (isOwnershipLost(fulfillmentError)) {
            throw fulfillmentError;
          }

          const error = fulfillmentError as Error;
          this.logger.error(
            `[executeConfirmPayment] Fulfillment order booking failed: ${error.message}`,
            error.stack,
          );

          try {
            await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
          } catch (voidError: unknown) {
            if (isOwnershipLost(voidError)) {
              throw voidError;
            }
            const voidErr = voidError as Error;
            this.logger.error(
              `[executeConfirmPayment] Payment gateway voidHold failed after fulfillment error: ${voidErr.message}`,
              voidErr.stack,
            );
          }

          const previousPaymentStatus = payment.status;
          enforceTransition(previousPaymentStatus, 'CANCELLED');
          const nextBookingStatus =
            bookingIntent.paymentAttemptCount < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

          let eventContext: TransactionEventContext | undefined;
          await this.prisma.$transaction(async (tx) => {
            eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'CANCELLED' },
            });
            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                eventType: 'payment_cancelled',
                previousStatus: previousPaymentStatus,
                newStatus: 'CANCELLED',
                amount: payment.amount,
                source: 'API',
                createdBy: userId,
              },
            });
            await tx.bookingIntent.update({
              where: { id: bookingIntent.id },
              data: { status: nextBookingStatus },
            });
            await this.bookingLifecycleService.updateToFailed(
              canonicalBooking.id,
              BookingFailureReason.SYSTEM_ERROR,
              undefined,
              undefined,
              undefined,
              tx,
              eventContext,
            );
          });
          if (eventContext && eventContext.events.length > 0 && this.publisher) {
            await this.publisher.publish(eventContext.events);
          }

          const failureResponse = {
            success: false,
            error: `Duffel booking failed: ${error.message || 'Unknown error'}. Payment hold released.`,
            bookingStatus: nextBookingStatus,
          };
          await this.idempotency.completeSagaKeyAtomic(
            currentOwnership,
            HttpStatus.BAD_GATEWAY,
            failureResponse,
          );

          throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
        }

        await this.idempotency.assertOwned(currentOwnership);
        await this.prisma.$transaction(async (tx) => {
          const currentPayment = await tx.payment.findUnique({ where: { id: payment.id } });
          if (currentPayment?.status !== 'AUTHORIZED') {
            throw new ConflictException(`Payment ${payment.id} status is no longer AUTHORIZED`);
          }
          await tx.paymentEvent.create({
            data: {
              paymentId: payment.id,
              eventType: 'duffel_order_created',
              previousStatus: 'AUTHORIZED',
              newStatus: 'AUTHORIZED',
              amount: payment.amount,
              source: 'API',
              metadata: orderOutcome.evidence as unknown as Prisma.InputJsonValue,
              createdBy: userId,
            },
          });
        });

        await this.idempotency.advanceSagaCheckpoint(currentOwnership, 'duffel_order_created');
        recoveryPoint = 'duffel_order_created';
      }

      if (recoveryPoint === 'duffel_order_created') {
        let captureOutcome: CapturePaymentOutcome | undefined;
        let captureFailed = false;
        let initialCaptureError: Error | undefined;

        try {
          captureOutcome = await this.paymentGateway.capturePayment(
            payment.stripePaymentIntentId,
            `${idempotencyKey}-stripe-capture`,
            control,
          );
          if (!captureOutcome || !captureOutcome.success || captureOutcome.status !== 'succeeded') {
            captureFailed = true;
            initialCaptureError = new Error(
              `Payment capture returned non-success status: ${captureOutcome?.status ?? 'unknown'}`,
            );
          }
        } catch (captureError: unknown) {
          if (isOwnershipLost(captureError)) {
            throw captureError;
          }
          captureFailed = true;
          initialCaptureError =
            captureError instanceof Error ? captureError : new Error(String(captureError));
        }

        if (captureFailed) {
          this.logger.error(
            `[executeConfirmPayment] Payment capture failed: ${initialCaptureError?.message}`,
            initialCaptureError?.stack,
          );

          let reconcileOutcome: AuthorizeHoldOutcome;
          try {
            reconcileOutcome = await this.paymentGateway.authorizeHold(
              payment.stripePaymentIntentId,
              control,
            );
          } catch (reconciliationError: unknown) {
            if (isOwnershipLost(reconciliationError)) {
              throw reconciliationError;
            }
            const reconciliationMessage =
              reconciliationError instanceof Error
                ? reconciliationError.message
                : String(reconciliationError);
            this.logger.error(
              `[executeConfirmPayment] Payment capture outcome remains unknown for payment ${payment.id}: ${reconciliationMessage}`,
            );
            throw new HttpException(
              {
                success: false,
                error: 'Stripe capture outcome is unknown. Retry payment confirmation.',
                bookingStatus: 'PROCESSING',
              },
              HttpStatus.BAD_GATEWAY,
            );
          }

          if (
            reconcileOutcome.status !== 'captured' &&
            reconcileOutcome.status !== 'authorized' &&
            reconcileOutcome.status !== 'voided'
          ) {
            throw new HttpException(
              {
                success: false,
                error: `Stripe capture outcome is not final (${
                  reconcileOutcome.rawStatus || reconcileOutcome.status
                }). Retry payment confirmation.`,
                bookingStatus: 'PROCESSING',
              },
              HttpStatus.BAD_GATEWAY,
            );
          }

          if (reconcileOutcome.status !== 'captured') {
            const duffelEvent = await this.prisma.paymentEvent.findFirst({
              where: {
                paymentId: payment.id,
                eventType: 'duffel_order_created',
              },
              orderBy: { createdAt: 'desc' },
            });
            const rawOrder = duffelEvent?.metadata;
            const duffelOrderId = readOrderId(rawOrder);

            if (duffelEvent && !duffelOrderId) {
              throw new HttpException(
                {
                  success: false,
                  error: `Stripe capture failed: ${initialCaptureError?.message || 'Unknown error'}. Fulfillment order cancellation is unconfirmed; retry confirmation.`,
                  bookingStatus: 'PROCESSING',
                },
                HttpStatus.BAD_GATEWAY,
              );
            }

            if (duffelOrderId) {
              try {
                const cancellation = await this.fulfillmentGateway.cancelOrder(
                  duffelOrderId,
                  control,
                );
                if (!isCancellationConfirmed(cancellation)) {
                  throw new Error('Fulfillment order cancellation is not confirmed');
                }
                this.logger.log(
                  `[executeConfirmPayment] Successfully cancelled fulfillment order ${duffelOrderId} as compensation.`,
                );
              } catch (cancelError: unknown) {
                if (isOwnershipLost(cancelError)) {
                  throw cancelError;
                }
                const err =
                  cancelError instanceof Error ? cancelError : new Error(String(cancelError));
                this.logger.error(
                  `[executeConfirmPayment] Fulfillment order cancellation failed during compensation: ${err.message}`,
                  err.stack,
                );
                throw new HttpException(
                  {
                    success: false,
                    error: `Stripe capture failed: ${initialCaptureError?.message || 'Unknown error'}. Fulfillment order cancellation is unconfirmed; retry confirmation.`,
                    bookingStatus: 'PROCESSING',
                  },
                  HttpStatus.BAD_GATEWAY,
                );
              }
            }

            try {
              await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
            } catch (voidError: unknown) {
              if (isOwnershipLost(voidError)) {
                throw voidError;
              }
              const err = voidError as Error;
              this.logger.error(
                `[executeConfirmPayment] Payment gateway voidHold failed during compensation: ${err.message}`,
                err.stack,
              );
            }

            const bookingIntent = await this.prisma.bookingIntent.findUnique({
              where: { id: payment.bookingIntentId },
            });
            const nextBookingStatus =
              (bookingIntent?.paymentAttemptCount || 0) < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

            let flightSnap: FlightSnapshot | undefined;
            let passSnap: PassengerSnapshot | undefined;
            let departAt: Date | undefined;

            if (duffelOrderId && rawOrder) {
              try {
                const fullBookingIntent = await this.prisma.bookingIntent.findUnique({
                  where: { id: payment.bookingIntentId },
                  include: { passengers: true, user: true },
                });
                const passengerEnrichment = this.mapPassengerEnrichment(
                  fullBookingIntent?.passengers,
                );
                const contactEmail = fullBookingIntent?.user?.email || '';

                const snaps = await this.fulfillmentGateway.retrieveOrderSnapshot(
                  duffelOrderId,
                  rawOrder as unknown as PersistedOrderEvidence,
                  passengerEnrichment,
                  contactEmail,
                  control,
                );
                flightSnap = snaps.flightSnapshot;
                passSnap = snaps.passengerSnapshot;
                departAt = snaps.departureAt;
              } catch (snapshotErr: unknown) {
                const err = snapshotErr as Error;
                this.logger.warn(
                  `[executeConfirmPayment] Failed to recover fulfillment order snapshots during capture compensation: ${err.message}`,
                  err.stack,
                );
              }
            }

            await this.idempotency.assertOwned(currentOwnership);

            let compensationAborted = false;
            let resolvedBookingStatus: string = nextBookingStatus;
            const previousPaymentStatus = payment.status;
            let eventContext: TransactionEventContext | undefined;
            await this.prisma.$transaction(async (tx) => {
              eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
              const paymentUpdate = await tx.payment.updateMany({
                where: {
                  id: payment.id,
                  status: {
                    in: [PaymentStatus.CREATED, PaymentStatus.AUTHORIZED],
                  },
                },
                data: { status: PaymentStatus.CANCELLED },
              });

              if (paymentUpdate.count === 0) {
                const latestPayment = await tx.payment.findUnique({
                  where: { id: payment.id },
                  select: { status: true },
                });
                const latestBookingIntent = await tx.bookingIntent.findUnique({
                  where: { id: payment.bookingIntentId },
                  select: { status: true },
                });
                if (latestBookingIntent?.status) {
                  resolvedBookingStatus = latestBookingIntent.status;
                }

                if (latestPayment?.status === PaymentStatus.SUCCEEDED) {
                  this.logger.warn(
                    `[executeConfirmPayment] Payment ${payment.id} is already SUCCEEDED; aborting compensation.`,
                  );
                  compensationAborted = true;
                  return;
                }
                this.logger.warn(
                  `[executeConfirmPayment] Payment ${payment.id} status is ${latestPayment?.status}; skipping cancellation compensation.`,
                );
                return;
              }

              enforceTransition(previousPaymentStatus, 'CANCELLED');
              await tx.paymentEvent.create({
                data: {
                  paymentId: payment.id,
                  eventType: 'payment_cancelled',
                  previousStatus: previousPaymentStatus,
                  newStatus: 'CANCELLED',
                  amount: payment.amount,
                  source: 'API',
                  createdBy: userId,
                },
              });
              await tx.bookingIntent.updateMany({
                where: {
                  id: payment.bookingIntentId,
                  status: { not: 'CONFIRMED' },
                },
                data: { status: nextBookingStatus },
              });
              await this.bookingLifecycleService.updateToFailed(
                canonicalBooking.id,
                BookingFailureReason.CAPTURE_FAILED,
                flightSnap,
                passSnap,
                departAt,
                tx,
                eventContext,
              );
            });
            if (eventContext && eventContext.events.length > 0 && this.publisher) {
              await this.publisher.publish(eventContext.events);
            }

            if (compensationAborted) {
              const duffelEvent = await this.prisma.paymentEvent.findFirst({
                where: {
                  paymentId: payment.id,
                  eventType: 'duffel_order_created',
                },
                orderBy: { createdAt: 'desc' },
              });

              const rawOrder = duffelEvent?.metadata as Record<string, unknown> | null;
              const duffelOrder = (rawOrder?.data || rawOrder || {}) as Record<string, unknown>;

              const successResponse = {
                success: true,
                paymentId: payment.id,
                status: 'SUCCEEDED',
                bookingReference: (duffelOrder.bookingReference ||
                  duffelOrder.booking_reference ||
                  '') as string,
                duffelOrderId: (duffelOrder.id || '') as string,
              };

              await this.idempotency.completeSagaKeyAtomic(
                currentOwnership,
                HttpStatus.OK,
                successResponse,
              );

              return successResponse;
            }

            const failureResponse = {
              success: false,
              error: `Stripe capture failed: ${
                initialCaptureError?.message || 'Unknown error'
              }. Duffel order cancelled and hold released.`,
              bookingStatus: resolvedBookingStatus,
            };
            await this.idempotency.completeSagaKeyAtomic(
              currentOwnership,
              HttpStatus.BAD_GATEWAY,
              failureResponse,
            );

            throw new HttpException(failureResponse, HttpStatus.BAD_GATEWAY);
          }
        }

        await this.idempotency.advanceSagaCheckpoint(currentOwnership, 'captured');
        recoveryPoint = 'captured';
      }

      if (recoveryPoint === 'captured') {
        const duffelEvent = await this.prisma.paymentEvent.findFirst({
          where: {
            paymentId: payment.id,
            eventType: 'duffel_order_created',
          },
          orderBy: { createdAt: 'desc' },
        });

        const rawOrder = duffelEvent?.metadata as Record<string, unknown> | null;
        if (!rawOrder || !rawOrder.id) {
          throw new InternalServerErrorException(
            'Duffel order details not found in payment history.',
          );
        }

        const fullBookingIntent = await this.prisma.bookingIntent.findUnique({
          where: { id: payment.bookingIntentId },
          include: { passengers: true, user: true },
        });

        const passengerEnrichment = this.mapPassengerEnrichment(fullBookingIntent?.passengers);
        const contactEmail = fullBookingIntent?.user?.email || '';

        const snapshotOutcome = await this.fulfillmentGateway.retrieveOrderSnapshot(
          rawOrder.id as string,
          rawOrder as unknown as PersistedOrderEvidence,
          passengerEnrichment,
          contactEmail,
          control,
        );

        const transactionId = crypto.randomUUID();
        if (payment.status !== 'SUCCEEDED') {
          const previousPaymentStatus = payment.status;
          enforceTransition(previousPaymentStatus, 'SUCCEEDED');
          await this.idempotency.assertOwned(currentOwnership);

          let eventContext: TransactionEventContext | undefined;
          await this.prisma.$transaction(async (tx) => {
            eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
            const updateResult = await tx.payment.updateMany({
              where: { id: payment.id, status: 'AUTHORIZED' },
              data: { status: 'SUCCEEDED' },
            });
            if (updateResult.count === 0) {
              throw new ConflictException(
                `Payment ${payment.id} is no longer in AUTHORIZED status`,
              );
            }

            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                eventType: 'payment_captured',
                previousStatus: previousPaymentStatus,
                newStatus: 'SUCCEEDED',
                amount: payment.amount,
                source: 'API',
                createdBy: userId,
              },
            });

            await tx.bookingIntent.update({
              where: { id: payment.bookingIntentId },
              data: { status: 'CONFIRMED' },
            });

            const pnr = (rawOrder.bookingReference || rawOrder.booking_reference) as string;
            await this.bookingLifecycleService.confirmBooking(
              canonicalBooking.id,
              pnr,
              rawOrder.id as string,
              snapshotOutcome.flightSnapshot,
              snapshotOutcome.passengerSnapshot,
              tx,
              eventContext,
            );

            await tx.ledgerEntry.createMany({
              data: [
                {
                  paymentId: payment.id,
                  transactionId,
                  accountId: 'CUSTOMER_RECEIVABLE',
                  entryType: 'DEBIT',
                  amount: payment.amount,
                  currency: payment.currency,
                },
                {
                  paymentId: payment.id,
                  transactionId,
                  accountId: 'PLATFORM_REVENUE',
                  entryType: 'CREDIT',
                  amount: payment.amount,
                  currency: payment.currency,
                },
              ],
            });
          });
          if (eventContext && eventContext.events.length > 0 && this.publisher) {
            try {
              await this.publisher.publish(eventContext.events);
            } catch (error) {
              this.logger.error(
                `[executeConfirmPayment] Failed to dispatch domain events after confirming payment ${payment.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                error instanceof Error ? error.stack : undefined,
              );
            }
          }

          await this.auditService.createLog(this.prisma, {
            userId,
            action: 'payment_captured',
            resourceType: 'Payment',
            resourceId: payment.id,
            metadata: {
              transactionId,
              amount: payment.amount,
              currency: payment.currency,
            },
          });

          const pnr = (rawOrder.bookingReference || rawOrder.booking_reference) as string;
          await this.auditService.createLog(this.prisma, {
            userId,
            action: 'booking_confirmed',
            resourceType: 'BookingIntent',
            resourceId: payment.bookingIntentId,
            metadata: {
              pnr,
              duffelOrderId: rawOrder.id as string,
            },
          });
        }

        if (payment.stripeCustomerId) {
          try {
            await this.paymentMethodService.saveMethod(
              userId,
              payment.stripeCustomerId,
              payment.stripePaymentIntentId,
            );
          } catch (methodError: unknown) {
            this.logger.warn(
              `[executeConfirmPayment] Unable to save payment method for payment ${payment.id}: ${
                methodError instanceof Error ? methodError.message : String(methodError)
              }`,
            );
          }
        }

        const bookingReference = (rawOrder.bookingReference ||
          rawOrder.booking_reference) as string;
        const successResponse = {
          success: true,
          paymentId: payment.id,
          status: 'SUCCEEDED',
          bookingReference,
          duffelOrderId: rawOrder.id as string,
        };

        await this.idempotency.completeSagaKeyAtomic(
          currentOwnership,
          HttpStatus.OK,
          successResponse,
        );

        return successResponse;
      }
    } catch (error) {
      this.logger.error(
        `[executeConfirmPayment] Error in executeConfirmPayment: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async handleBackgroundError(
    paymentId: string,
    idempotencyKey: string,
    userId: string,
    ownership: SagaOwnership,
    error: unknown,
  ): Promise<void> {
    try {
      try {
        await this.idempotency.assertOwned(ownership);
      } catch (leaseError: unknown) {
        this.logger.warn(
          `[handleBackgroundError] Ownership lost in handleBackgroundError for key ${idempotencyKey}: ${
            leaseError instanceof Error ? leaseError.message : String(leaseError)
          }`,
        );
        return;
      }

      const control: PortInvocationControl = {
        beforeInvoke: () => this.idempotency.assertOwned(ownership),
      };

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          ancillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: true,
            },
          },
        },
      });

      if (
        !payment ||
        payment.status === 'SUCCEEDED' ||
        payment.status === 'CANCELLED' ||
        payment.status === 'FAILED' ||
        payment.status === 'EXPIRED'
      ) {
        return;
      }

      let authOutcome: AuthorizeHoldOutcome;
      try {
        authOutcome = await this.paymentGateway.authorizeHold(
          payment.stripePaymentIntentId,
          control,
        );
      } catch (gatewayErr: unknown) {
        if (isOwnershipLost(gatewayErr)) {
          return;
        }
        this.logger.warn(
          `[handleBackgroundError] Failed to retrieve payment intent for payment ${paymentId}: ${
            gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr)
          }`,
        );
        return;
      }

      const finalStatuses = ['captured', 'authorized', 'voided'];
      if (!finalStatuses.includes(authOutcome.status)) {
        this.logger.warn(
          `[handleBackgroundError] Payment intent for payment ${paymentId} is in non-final status: ${
            authOutcome.rawStatus || authOutcome.status
          }. Warning and returning early for authoritative recovery.`,
        );
        return;
      }

      if (authOutcome.status === 'captured') {
        const recoveryPoint = await this.idempotency.getResumePoint(idempotencyKey);
        if (recoveryPoint !== 'captured' && recoveryPoint !== 'completed') {
          try {
            await this.idempotency.advanceSagaCheckpoint(ownership, 'captured');
          } catch (updateErr: unknown) {
            this.logger.error(
              `[handleBackgroundError] Failed to advance recovery point to 'captured' for payment ${paymentId}: ${
                updateErr instanceof Error ? updateErr.message : String(updateErr)
              }`,
            );
          }
        }

        this.logger.error(
          `[handleBackgroundError] CRITICAL: Background confirmation failed after Stripe capture for payment ${paymentId}. Customer has been charged. Retries will attempt to resume post-capture updates.`,
          error instanceof Error ? error.stack : undefined,
        );
        return;
      }

      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: {
          paymentId,
          eventType: 'duffel_order_created',
        },
        orderBy: { createdAt: 'desc' },
      });

      if (authOutcome.status === 'authorized' || authOutcome.status === 'voided') {
        if (duffelEvent) {
          const rawOrder = duffelEvent.metadata as Record<string, unknown> | null;
          const duffelOrderId = readOrderId(rawOrder);
          if (!duffelOrderId) {
            this.logger.error(
              `[handleBackgroundError] Background cancellation cannot be attempted because the order ID is missing or invalid for payment ${paymentId}.`,
            );
            return;
          }

          try {
            const cancellation = await this.fulfillmentGateway.cancelOrder(
              duffelOrderId,
              control,
            );
            if (!isCancellationConfirmed(cancellation)) {
              throw new Error('Fulfillment order cancellation is not confirmed');
            }
          } catch (cancelError: unknown) {
            if (isOwnershipLost(cancelError)) {
              return;
            }
            const err =
              cancelError instanceof Error ? cancelError : new Error(String(cancelError));
            this.logger.error(
              `[handleBackgroundError] Background cancelOrder failed: ${err.message}`,
              err.stack,
            );
            return;
          }
        }

        if (authOutcome.status === 'authorized') {
          try {
            await this.paymentGateway.voidHold(payment.stripePaymentIntentId, control);
          } catch (voidError: unknown) {
            if (isOwnershipLost(voidError)) {
              return;
            }
            const err = voidError as Error;
            this.logger.error(
              `[handleBackgroundError] Background voidHold failed: ${err.message}`,
              err.stack,
            );
          }
        }
      }

      const bookingIntent = await this.prisma.bookingIntent.findUnique({
        where: { id: payment.bookingIntentId },
        include: { passengers: true, user: true },
      });
      const nextBookingStatus =
        (bookingIntent?.paymentAttemptCount || 0) < 2 ? 'AWAITING_PAYMENT' : 'CANCELLED';

      const booking = await this.prisma.booking.findFirst({
        where: { paymentId: payment.id },
      });

      let flightSnap: FlightSnapshot | undefined;
      let passSnap: PassengerSnapshot | undefined;
      let departAt: Date | undefined;
      if (booking && duffelEvent) {
        try {
          const rawOrder = duffelEvent.metadata as Record<string, unknown>;
          const duffelOrderId = readOrderId(rawOrder);
          if (duffelOrderId) {
            const passengerEnrichment = this.mapPassengerEnrichment(bookingIntent?.passengers);
            const contactEmail = bookingIntent?.user?.email || '';

            const snaps = await this.fulfillmentGateway.retrieveOrderSnapshot(
              duffelOrderId,
              rawOrder as unknown as PersistedOrderEvidence,
              passengerEnrichment,
              contactEmail,
              control,
            );
            flightSnap = snaps.flightSnapshot;
            passSnap = snaps.passengerSnapshot;
            departAt = snaps.departureAt;
          }
        } catch (e: unknown) {
          const err = e as Error;
          this.logger.warn(
            `[handleBackgroundError] Failed to recover fulfillment order snapshots in background handler: ${err.message}`,
            err.stack,
          );
        }
      }

      try {
        await this.idempotency.assertOwned(ownership);
      } catch (ownershipErr) {
        if (isOwnershipLost(ownershipErr)) {
          this.logger.warn(
            `[handleBackgroundError] Ownership lost before compensation transaction for payment ${paymentId}; aborting.`,
          );
          return;
        }
        throw ownershipErr;
      }

      let compensationAborted = false;
      let resolvedBookingStatus: string = nextBookingStatus;
      const previousPaymentStatus = payment.status;
      let eventContext: TransactionEventContext | undefined;
      await this.prisma.$transaction(async (tx) => {
        eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
        const paymentUpdate = await tx.payment.updateMany({
          where: {
            id: paymentId,
            status: {
              in: [PaymentStatus.CREATED, PaymentStatus.AUTHORIZED],
            },
          },
          data: { status: PaymentStatus.CANCELLED },
        });

        if (paymentUpdate.count === 0) {
          const latestPayment = await tx.payment.findUnique({
            where: { id: paymentId },
            select: { status: true },
          });
          const latestBookingIntent = await tx.bookingIntent.findUnique({
            where: { id: payment.bookingIntentId },
            select: { status: true },
          });
          if (latestBookingIntent?.status) {
            resolvedBookingStatus = latestBookingIntent.status;
          }

          if (latestPayment?.status === PaymentStatus.SUCCEEDED) {
            this.logger.warn(
              `[handleBackgroundError] Payment ${paymentId} is already SUCCEEDED; aborting compensation.`,
            );
            compensationAborted = true;
            return;
          }
          this.logger.warn(
            `[handleBackgroundError] Payment ${paymentId} status is ${latestPayment?.status}; skipping cancellation compensation.`,
          );
          return;
        }

        enforceTransition(previousPaymentStatus, 'CANCELLED');
        await tx.paymentEvent.create({
          data: {
            paymentId,
            eventType: 'payment_cancelled',
            previousStatus: previousPaymentStatus,
            newStatus: 'CANCELLED',
            amount: payment.amount,
            source: 'API',
            createdBy: userId,
          },
        });
        await tx.bookingIntent.updateMany({
          where: {
            id: payment.bookingIntentId,
            status: { not: 'CONFIRMED' },
          },
          data: { status: nextBookingStatus },
        });
        if (booking) {
          await this.bookingLifecycleService.updateToFailed(
            booking.id,
            BookingFailureReason.SYSTEM_ERROR,
            flightSnap,
            passSnap,
            departAt,
            tx,
            eventContext,
          );
        }
      });
      if (eventContext && eventContext.events.length > 0 && this.publisher) {
        await this.publisher.publish(eventContext.events);
      }

      if (compensationAborted) {
        const rawOrder = duffelEvent?.metadata as Record<string, unknown> | null;
        const duffelOrder = (rawOrder?.data || rawOrder || {}) as Record<string, unknown>;
        const successResponse = {
          success: true,
          paymentId,
          status: 'SUCCEEDED',
          bookingReference: (duffelOrder.bookingReference ||
            duffelOrder.booking_reference ||
            '') as string,
          duffelOrderId: (duffelOrder.id || '') as string,
        };

        await this.idempotency.completeSagaKeyAtomic(
          ownership,
          HttpStatus.OK,
          successResponse,
        );

        return;
      }

      const errObj = error as Error;
      await this.idempotency.completeSagaKeyAtomic(ownership, HttpStatus.BAD_GATEWAY, {
        success: false,
        error: `Background processing failed: ${errObj.message || 'Unknown error'}. Hold released.`,
        bookingStatus: resolvedBookingStatus,
      });
    } catch (err: unknown) {
      const errorObj = err as Error;
      this.logger.error(
        `[handleBackgroundError] Error in handleBackgroundError: ${errorObj.message}`,
        errorObj.stack,
      );
    }
  }

  private mapPassengerEnrichment(
    passengers?: Array<{
      id?: string;
      givenName?: string;
      familyName?: string;
      firstName?: string;
      lastName?: string;
      title?: string | null;
      gender?: string | null;
      dateOfBirth?: Date | string | null;
      type?: string | null;
      passengerType?: string | null;
      email?: string | null;
      phoneNumber?: string | null;
    }>,
  ): PassengerEnrichmentInput[] {
    return (passengers || []).map((p) => ({
      id: p.id,
      firstName: p.givenName || p.firstName,
      lastName: p.familyName || p.lastName,
      title: p.title ?? undefined,
      gender: p.gender ?? undefined,
      dateOfBirth: p.dateOfBirth
        ? p.dateOfBirth instanceof Date
          ? p.dateOfBirth.toISOString().split('T')[0]
          : String(p.dateOfBirth).split('T')[0]
        : undefined,
      passengerType: p.type ? String(p.type).toLowerCase() : p.passengerType ?? undefined,
      email: p.email ?? undefined,
      phoneNumber: p.phoneNumber ?? undefined,
    }));
  }
}
