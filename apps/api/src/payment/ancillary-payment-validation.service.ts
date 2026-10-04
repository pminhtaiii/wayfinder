import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AncillarySelectionStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';

export type ValidateAncillaryPaymentInput = {
  userId: string;
  bookingIntentId: string;
  ancillarySelectionId: string;
  ancillarySelectionVersion: number;
};

export type ValidatedAncillaryPayment = {
  selectionId: string;
  selectionVersion: number;
  baseAmount: string;
  grandTotal: string;
  currency: string;
  services: Array<{ serviceId: string; quantity: number }>;
};

type ValidationIntent = Prisma.BookingIntentGetPayload<{
  include: {
    currentAncillarySelection: {
      include: {
        seatSelections: true;
        baggageSelections: { include: { segments: true } };
      };
    };
  };
}>;

type LeasedSnapshot = {
  intent: ValidationIntent;
  leaseToken: string;
  services: Array<{ serviceId: string; quantity: number }>;
};

const LEASE_DURATION_MS = 30_000;
const REPRICING_TIMEOUT_MS = 15_000;

@Injectable()
export class AncillaryPaymentValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ancillaryService: DuffelAncillaryService,
  ) {}

  async validateForPayment(
    input: ValidateAncillaryPaymentInput,
  ): Promise<ValidatedAncillaryPayment> {
    const leased = await this.acquireLease(input);
    let pricing: Awaited<ReturnType<DuffelAncillaryService['repriceOffer']>>;

    try {
      pricing = await this.withTimeout(
        this.ancillaryService.repriceOffer(leased.intent.supplierOfferId, leased.services),
        REPRICING_TIMEOUT_MS,
      );
    } catch (error) {
      await this.releaseLease(input, leased.leaseToken);
      throw error;
    }

    const selection = leased.intent.currentAncillarySelection;
    if (!selection) {
      await this.releaseLease(input, leased.leaseToken);
      throw this.versionConflict(input.bookingIntentId, leased.intent.ancillaryVersion);
    }

    if (
      pricing.invalidServiceIdentities.length > 0 ||
      !this.sameServices(leased.services, pricing.serviceLines)
    ) {
      await this.markStale(input, leased.leaseToken);
      throw new ConflictException({
        code: 'ANCILLARY_SELECTION_STALE',
        intentId: input.bookingIntentId,
        currentVersion: input.ancillarySelectionVersion,
        invalidSelections: this.invalidSelections(selection, pricing.invalidServiceIdentities),
      });
    }

    const expectedCurrency = selection.currency.toUpperCase();
    if (pricing.currency.toUpperCase() !== expectedCurrency) {
      await this.markStale(input, leased.leaseToken);
      throw new BadRequestException({
        code: 'ANCILLARY_CURRENCY_MISMATCH',
        intentId: input.bookingIntentId,
      });
    }

    const previousBase = new Prisma.Decimal(leased.intent.confirmedPrice);
    const previousGrand = previousBase.add(selection.total);
    const currentBase = new Prisma.Decimal(pricing.baseAmount);
    const currentGrand = new Prisma.Decimal(pricing.totalAmount);
    if (!currentBase.equals(previousBase) || !currentGrand.equals(previousGrand)) {
      await this.markStale(input, leased.leaseToken);
      throw new ConflictException({
        code: 'ANCILLARY_PRICE_CHANGED',
        intentId: input.bookingIntentId,
        currentVersion: input.ancillarySelectionVersion,
        pricing: {
          previousGrandTotal: previousGrand.toFixed(2),
          currentGrandTotal: currentGrand.toFixed(2),
          currency: pricing.currency.toUpperCase(),
        },
      });
    }

    await this.persistValidated(input, leased.leaseToken, {
      baseAmount: currentBase.toFixed(2),
      grandTotal: currentGrand.toFixed(2),
      currency: expectedCurrency,
    });

    return {
      selectionId: input.ancillarySelectionId,
      selectionVersion: input.ancillarySelectionVersion,
      baseAmount: currentBase.toFixed(2),
      grandTotal: currentGrand.toFixed(2),
      currency: expectedCurrency,
      services: leased.services,
    };
  }

  private async acquireLease(input: ValidateAncillaryPaymentInput): Promise<LeasedSnapshot> {
    const leaseToken = randomUUID();

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id
        FROM booking_intents
        WHERE id = ${input.bookingIntentId}
        FOR UPDATE
      `;
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
      const intent = await transaction.bookingIntent.findUnique({
        where: { id: input.bookingIntentId },
        include: {
          currentAncillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: { include: { segments: true } },
            },
          },
        },
      });
      this.assertCurrentIntent(intent, input, now);
      const selection = intent.currentAncillarySelection;
      if (!selection) {
        throw this.versionConflict(input.bookingIntentId, intent.ancillaryVersion);
      }

      const leased = await transaction.ancillarySelection.updateMany({
        where: {
          id: input.ancillarySelectionId,
          bookingIntentId: input.bookingIntentId,
          version: input.ancillarySelectionVersion,
          status: {
            in: [AncillarySelectionStatus.DRAFT_COMMITTED, AncillarySelectionStatus.VALIDATED],
          },
          OR: [{ validationLeaseToken: null }, { validationLeaseExpiresAt: { lte: now } }],
        },
        data: {
          validationLeaseToken: leaseToken,
          validationLeaseExpiresAt: leaseExpiresAt,
        },
      });
      if (leased.count !== 1) {
        throw this.versionConflict(input.bookingIntentId, intent.ancillaryVersion);
      }

      return {
        intent,
        leaseToken,
        services: this.canonicalServices(selection),
      };
    });
  }

  private async persistValidated(
    input: ValidateAncillaryPaymentInput,
    leaseToken: string,
    pricing: { baseAmount: string; grandTotal: string; currency: string },
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id
        FROM booking_intents
        WHERE id = ${input.bookingIntentId}
        FOR UPDATE
      `;
      const now = new Date();
      const selection = await transaction.ancillarySelection.updateMany({
        where: {
          id: input.ancillarySelectionId,
          bookingIntentId: input.bookingIntentId,
          version: input.ancillarySelectionVersion,
          status: {
            in: [AncillarySelectionStatus.DRAFT_COMMITTED, AncillarySelectionStatus.VALIDATED],
          },
          validationLeaseToken: leaseToken,
          validationLeaseExpiresAt: { gt: now },
        },
        data: {
          status: AncillarySelectionStatus.VALIDATED,
          validatedBaseAmount: pricing.baseAmount,
          validatedGrandTotal: pricing.grandTotal,
          validatedAt: now,
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        },
      });
      if (selection.count !== 1) {
        throw this.versionConflict(input.bookingIntentId, input.ancillarySelectionVersion);
      }

      const intent = await transaction.bookingIntent.updateMany({
        where: {
          id: input.bookingIntentId,
          currentAncillarySelectionId: input.ancillarySelectionId,
          ancillaryVersion: input.ancillarySelectionVersion,
          status: 'PENDING',
          intentExpiresAt: { gt: now },
          currency: pricing.currency,
          OR: [{ offerExpiresAt: null }, { offerExpiresAt: { gt: now } }],
        },
        data: {
          ancillaryStatus: 'VALIDATED',
          validatedTotal: pricing.grandTotal,
          ancillariesValidatedAt: now,
        },
      });
      if (intent.count !== 1) {
        throw this.versionConflict(input.bookingIntentId, input.ancillarySelectionVersion);
      }
    });
  }

  private async markStale(input: ValidateAncillaryPaymentInput, leaseToken: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id
        FROM booking_intents
        WHERE id = ${input.bookingIntentId}
        FOR UPDATE
      `;
      const now = new Date();
      const selection = await transaction.ancillarySelection.updateMany({
        where: {
          id: input.ancillarySelectionId,
          bookingIntentId: input.bookingIntentId,
          version: input.ancillarySelectionVersion,
          status: {
            in: [AncillarySelectionStatus.DRAFT_COMMITTED, AncillarySelectionStatus.VALIDATED],
          },
          validationLeaseToken: leaseToken,
          validationLeaseExpiresAt: { gt: now },
        },
        data: {
          status: AncillarySelectionStatus.STALE,
          validatedBaseAmount: null,
          validatedGrandTotal: null,
          validatedAt: null,
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        },
      });
      if (selection.count !== 1) {
        throw this.versionConflict(input.bookingIntentId, input.ancillarySelectionVersion);
      }
      const intent = await transaction.bookingIntent.updateMany({
        where: {
          id: input.bookingIntentId,
          currentAncillarySelectionId: input.ancillarySelectionId,
          ancillaryVersion: input.ancillarySelectionVersion,
          status: 'PENDING',
          intentExpiresAt: { gt: now },
          OR: [{ offerExpiresAt: null }, { offerExpiresAt: { gt: now } }],
        },
        data: {
          ancillaryStatus: 'STALE',
          validatedTotal: null,
          ancillariesValidatedAt: null,
        },
      });
      if (intent.count !== 1) {
        throw this.versionConflict(input.bookingIntentId, input.ancillarySelectionVersion);
      }
    });
  }

  private async releaseLease(
    input: ValidateAncillaryPaymentInput,
    leaseToken: string,
  ): Promise<void> {
    await this.prisma.ancillarySelection.updateMany({
      where: {
        id: input.ancillarySelectionId,
        bookingIntentId: input.bookingIntentId,
        version: input.ancillarySelectionVersion,
        validationLeaseToken: leaseToken,
      },
      data: {
        validationLeaseToken: null,
        validationLeaseExpiresAt: null,
      },
    });
  }

  private assertCurrentIntent(
    intent: ValidationIntent | null,
    input: ValidateAncillaryPaymentInput,
    now: Date,
  ): asserts intent is ValidationIntent {
    if (!intent) {
      throw new NotFoundException({ code: 'INTENT_NOT_FOUND' });
    }
    if (intent.userId !== input.userId) {
      throw new ForbiddenException({ code: 'INTENT_FORBIDDEN' });
    }
    if (intent.status === 'EXPIRED' || intent.intentExpiresAt <= now) {
      throw new GoneException({ code: 'INTENT_EXPIRED' });
    }
    if (intent.offerExpiresAt && intent.offerExpiresAt <= now) {
      throw new GoneException({ code: 'OFFER_EXPIRED' });
    }
    if (intent.status !== 'PENDING') {
      throw new ConflictException({
        code: 'ANCILLARY_SELECTION_STALE',
        intentId: input.bookingIntentId,
        currentVersion: intent.ancillaryVersion,
      });
    }
    if (
      intent.currentAncillarySelectionId !== input.ancillarySelectionId ||
      intent.ancillaryVersion !== input.ancillarySelectionVersion
    ) {
      throw this.versionConflict(input.bookingIntentId, intent.ancillaryVersion);
    }
  }

  private canonicalServices(
    selection: NonNullable<ValidationIntent['currentAncillarySelection']>,
  ): Array<{ serviceId: string; quantity: number }> {
    const quantities = new Map<string, number>();
    for (const seat of selection.seatSelections) {
      quantities.set(seat.serviceId, (quantities.get(seat.serviceId) ?? 0) + 1);
    }
    for (const baggage of selection.baggageSelections) {
      quantities.set(
        baggage.serviceId,
        (quantities.get(baggage.serviceId) ?? 0) + baggage.quantity,
      );
    }
    return [...quantities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([serviceId, quantity]) => ({ serviceId, quantity }));
  }

  private sameServices(
    expected: Array<{ serviceId: string; quantity: number }>,
    actual: Array<{ serviceId: string; quantity: number }>,
  ): boolean {
    const quantities = new Map<string, number>();
    for (const line of actual) {
      quantities.set(line.serviceId, (quantities.get(line.serviceId) ?? 0) + line.quantity);
    }
    return (
      expected.length === quantities.size &&
      expected.every((service) => quantities.get(service.serviceId) === service.quantity)
    );
  }

  private invalidSelections(
    selection: NonNullable<ValidationIntent['currentAncillarySelection']>,
    invalidIds: string[],
  ): Array<Record<string, unknown>> {
    const invalid = new Set(invalidIds);
    const seatRows = selection.seatSelections
      .filter((seat) => invalid.size === 0 || invalid.has(seat.serviceId))
      .map((seat) => ({
        kind: 'SEAT',
        serviceId: seat.serviceId,
        intentPassengerId: seat.intentPassengerId,
        segmentIds: [seat.segmentId],
        reason: 'UNAVAILABLE',
      }));
    const baggageRows = selection.baggageSelections
      .filter((baggage) => invalid.size === 0 || invalid.has(baggage.serviceId))
      .map((baggage) => ({
        kind: 'BAGGAGE',
        serviceId: baggage.serviceId,
        intentPassengerId: baggage.intentPassengerId,
        segmentIds: baggage.segments.map((segment) => segment.segmentId),
        reason: 'UNAVAILABLE',
      }));
    return [...seatRows, ...baggageRows];
  }

  private versionConflict(intentId: string, currentVersion: number): ConflictException {
    return new ConflictException({
      code: 'ANCILLARY_VERSION_CONFLICT',
      intentId,
      currentVersion,
    });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new GatewayTimeoutException({
            code: 'ANCILLARY_REPRICING_TIMEOUT',
            message: 'External ancillary repricing request timed out',
          }),
        );
      }, timeoutMs);
    });

    promise.catch(() => {});

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
