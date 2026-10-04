import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AncillaryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { AncillaryCatalogService } from './ancillary-catalog.service';
import { CommitAncillarySelectionDto } from './dto/commit-ancillary-selection.dto';
import { calculateAncillaryTotals } from './ancillary-pricing';
import type { AncillaryPassenger } from '@shared/types/ancillary.types';
import {
  AncillarySelectionValidationError,
  validateAncillarySelection,
} from './ancillary-selection.validator';

type OwnedIntent = Prisma.BookingIntentGetPayload<{
  include: {
    passengers: true;
    currentAncillarySelection: {
      include: { seatSelections: true; baggageSelections: { include: { segments: true } } };
    };
  };
}>;

@Injectable()
export class AncillariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: AncillaryCatalogService,
    private readonly idempotency: PaymentIdempotencyService,
    private readonly audit: AuditService,
  ) {}

  async read(userId: string, intentId: string, refresh = false) {
    const intent = await this.loadOwned(userId, intentId);
    const catalog = await this.catalogService.getCatalog(intent.supplierOfferId, refresh);
    const passengers = this.passengers(intent).map(({ supplierPassengerId, ...passenger }) => ({
      ...passenger,
      duffelPassengerId: supplierPassengerId,
    }));
    const selection = this.snapshot(
      intent.currentAncillarySelection,
      intent.confirmedPrice,
      intent.currency,
    );
    return {
      intentId,
      selectionId: intent.currentAncillarySelectionId,
      selectionVersion: intent.ancillaryVersion,
      selectionStatus: intent.ancillaryStatus,
      currency: intent.currency,
      baseAmount: String(intent.confirmedPrice),
      catalog: { ...catalog, fingerprint: this.catalogService.fingerprint(catalog) },
      passengers,
      selection,
    };
  }

  async commit(userId: string, intentId: string, key: string, dto: CommitAncillarySelectionDto) {
    const requestPath = `/bookings/intent/${intentId}/ancillaries`;
    const requestHash = this.idempotency.computeHash(dto);
    const acquired = await this.idempotency.acquireOrReplay(key, requestHash, userId, requestPath);
    if (acquired.status === 'replay') return JSON.parse(acquired.responseBody);
    try {
      const intent = await this.loadOwned(userId, intentId);

      const catalog = await this.catalogService.getCatalog(intent.supplierOfferId);
      if (dto.catalogFingerprint !== this.catalogService.fingerprint(catalog)) {
        throw new ConflictException({
          code: 'ANCILLARY_SELECTION_STALE',
          intentId,
          currentVersion: intent.ancillaryVersion,
          invalidSelections: [],
        });
      }
      let valid;
      try {
        valid = validateAncillarySelection({
          catalog,
          passengers: this.passengers(intent),
          seats: dto.seats,
          baggage: dto.baggage,
          expectedCurrency: intent.currency,
        });
      } catch (error) {
        if (error instanceof AncillarySelectionValidationError) {
          throw new BadRequestException({
            code: error.code,
            intentId,
            invalidSelections: error.invalidSelections,
          });
        }
        throw error;
      }
      const totals = calculateAncillaryTotals({
        baseAmount: String(intent.confirmedPrice),
        currency: intent.currency,
        seats: valid.seats,
        baggage: valid.baggage,
      });
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
        SELECT id
        FROM booking_intents
        WHERE id = ${intentId}
        FOR UPDATE
      `;
        const leaseState = await tx.bookingIntent.findUnique({
          where: { id: intentId },
          select: {
            ancillaryVersion: true,
            currentAncillarySelection: {
              select: {
                validationLeaseToken: true,
                validationLeaseExpiresAt: true,
              },
            },
          },
        });
        const lease = leaseState?.currentAncillarySelection;
        if (
          leaseState?.ancillaryVersion !== dto.expectedVersion ||
          (lease?.validationLeaseToken &&
            lease.validationLeaseExpiresAt &&
            lease.validationLeaseExpiresAt > new Date())
        ) {
          throw new ConflictException({
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId,
            currentVersion: leaseState?.ancillaryVersion ?? intent.ancillaryVersion,
          });
        }
        const selection = await tx.ancillarySelection.create({
          data: {
            bookingIntentId: intentId,
            version: dto.expectedVersion + 1,
            status: 'DRAFT_COMMITTED',
            currency: intent.currency,
            seatTotal: new Prisma.Decimal(totals.seats),
            baggageTotal: new Prisma.Decimal(totals.baggage),
            total: new Prisma.Decimal(totals.ancillaries),
            catalogFingerprint: dto.catalogFingerprint,
            seatSelections: {
              create: valid.seats.map((seat) => ({
                intentPassengerId: seat.intentPassengerId,
                supplierPassengerId: this.supplierPassengerId(intent, seat.intentPassengerId),
                segmentId: seat.segmentId,
                serviceId: seat.serviceId,
                seatDesignator: seat.seatDesignator,
                amount: new Prisma.Decimal(seat.amount),
                currency: seat.currency,
              })),
            },
            baggageSelections: {
              create: valid.baggage.map((bag) => ({
                intentPassengerId: bag.intentPassengerId,
                supplierPassengerId: this.supplierPassengerId(intent, bag.intentPassengerId),
                serviceId: bag.serviceId,
                type: bag.type === 'carry_on' ? 'CARRY_ON' : 'CHECKED',
                weightValue: bag.weightValue,
                weightUnit: bag.weightUnit === 'lb' ? 'LB' : bag.weightUnit === 'kg' ? 'KG' : null,
                quantity: bag.quantity,
                amount: new Prisma.Decimal(bag.amount),
                currency: bag.currency,
                segments: { create: bag.segmentIds.map((segmentId) => ({ segmentId })) },
              })),
            },
          },
        });
        const advanced = await tx.bookingIntent.updateMany({
          where: {
            id: intentId,
            userId,
            status: 'PENDING',
            ancillaryVersion: dto.expectedVersion,
            intentExpiresAt: { gt: new Date() },
          },
          data: {
            currentAncillarySelectionId: selection.id,
            ancillaryVersion: dto.expectedVersion + 1,
            ancillaryStatus: AncillaryStatus.DRAFT_COMMITTED,
            ancillaryCurrency: intent.currency,
            seatTotal: new Prisma.Decimal(totals.seats),
            baggageTotal: new Prisma.Decimal(totals.baggage),
            ancillaryTotal: new Prisma.Decimal(totals.ancillaries),
            validatedTotal: null,
            ancillariesValidatedAt: null,
          },
        });
        if (advanced.count !== 1)
          throw new ConflictException({ code: 'ANCILLARY_VERSION_CONFLICT' });
        await this.audit.createLog(tx, {
          userId,
          action: 'ancillary_selection_committed',
          resourceType: 'BookingIntent',
          resourceId: intentId,
          metadata: {
            intentId,
            selectionId: selection.id,
            version: selection.version,
            seatCount: valid.seats.length,
            baggageCount: valid.baggage.length,
            ancillaryTotal: totals.ancillaries,
            currency: intent.currency,
          },
        });
        const response = {
          intentId,
          selectionId: selection.id,
          selectionVersion: selection.version,
          selectionStatus: 'DRAFT_COMMITTED',
          intentExpiresAt: intent.intentExpiresAt.toISOString(),
          selection: { seats: valid.seats, baggage: valid.baggage, totals },
        };
        await tx.idempotencyKey.update({
          where: { key },
          data: {
            responseCode: 200,
            responseBody: response as Prisma.InputJsonValue,
            lockedAt: null,
          },
        });
        return response;
      });
    } catch (error) {
      await this.idempotency.abandonAcquiredKey(
        key,
        requestHash,
        userId,
        requestPath,
        acquired.lockedAt,
      );
      if (
        !(error instanceof ConflictException) ||
        (error.getResponse() as { code?: string }).code !== 'ANCILLARY_VERSION_CONFLICT'
      )
        throw error;
      const current = await this.loadOwned(userId, intentId);
      throw new ConflictException({
        code: 'ANCILLARY_VERSION_CONFLICT',
        intentId,
        currentVersion: current.ancillaryVersion,
        selection: this.snapshot(
          current.currentAncillarySelection,
          current.confirmedPrice,
          current.currency,
        ),
      });
    }
  }

  private async loadOwned(userId: string, id: string): Promise<OwnedIntent> {
    const intent = await this.prisma.bookingIntent.findUnique({
      where: { id },
      include: {
        passengers: { orderBy: { position: 'asc' } },
        currentAncillarySelection: {
          include: { seatSelections: true, baggageSelections: { include: { segments: true } } },
        },
      },
    });
    if (!intent) throw new NotFoundException({ code: 'INTENT_NOT_FOUND' });
    if (intent.userId !== userId) throw new ForbiddenException({ code: 'INTENT_FORBIDDEN' });
    if (intent.status === 'EXPIRED' || intent.intentExpiresAt <= new Date())
      throw new GoneException({ code: 'INTENT_EXPIRED' });
    if (intent.offerExpiresAt && intent.offerExpiresAt <= new Date())
      throw new GoneException({ code: 'OFFER_EXPIRED' });
    if (intent.status !== 'PENDING')
      throw new ConflictException({
        code: 'ANCILLARY_SELECTION_STALE',
        intentId: id,
        currentVersion: intent.ancillaryVersion,
      });
    return intent;
  }

  private passengers(intent: OwnedIntent): AncillaryPassenger[] {
    const ids = new Set<string>();
    return intent.passengers.map((passenger) => {
      if (!passenger.supplierPassengerId || ids.has(passenger.supplierPassengerId))
        throw new BadRequestException({ code: 'ANCILLARY_SCOPE_INVALID', intentId: intent.id });
      ids.add(passenger.supplierPassengerId);
      return {
        intentPassengerId: passenger.id,
        supplierPassengerId: passenger.supplierPassengerId,
        displayName: passenger.givenName,
        type: passenger.type,
        seatEligible: passenger.type !== 'INFANT',
      };
    });
  }

  private supplierPassengerId(intent: OwnedIntent, localId: string) {
    const value = intent.passengers.find(
      (passenger) => passenger.id === localId,
    )?.supplierPassengerId;
    if (!value)
      throw new BadRequestException({ code: 'ANCILLARY_SCOPE_INVALID', intentId: intent.id });
    return value;
  }

  private snapshot(
    selection: OwnedIntent['currentAncillarySelection'],
    base: Prisma.Decimal,
    currency: string,
  ) {
    if (!selection)
      return {
        seats: [],
        baggage: [],
        totals: {
          seats: '0.00',
          baggage: '0.00',
          ancillaries: '0.00',
          estimatedGrandTotal: String(base),
          currency,
        },
      };
    return {
      seats: selection.seatSelections.map((seat) => ({
        intentPassengerId: seat.intentPassengerId,
        segmentId: seat.segmentId,
        serviceId: seat.serviceId,
        seatDesignator: seat.seatDesignator,
        amount: String(seat.amount),
        currency: seat.currency,
      })),
      baggage: selection.baggageSelections.map((bag) => ({
        intentPassengerId: bag.intentPassengerId,
        serviceId: bag.serviceId,
        type: bag.type.toLowerCase(),
        weightValue: bag.weightValue,
        weightUnit: bag.weightUnit?.toLowerCase() ?? null,
        quantity: bag.quantity,
        amount: String(bag.amount),
        currency: bag.currency,
        segmentIds: bag.segments.map((segment) => segment.segmentId),
      })),
      totals: {
        seats: String(selection.seatTotal),
        baggage: String(selection.baggageTotal),
        ancillaries: String(selection.total),
        estimatedGrandTotal: (Number(base) + Number(selection.total)).toFixed(2),
        currency,
      },
    };
  }
}
