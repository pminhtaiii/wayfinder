import {
  IsInt,
  Max,
  Min,
  IsString,
  Matches,
  IsOptional,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { FlightMatchResult } from '@/flight-match/flight-match.types';

export function IsFutureDateString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isFutureDateString',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

          const parsedDate = new Date(`${value}T00:00:00Z`);
          if (isNaN(parsedDate.getTime())) return false;

          const todayUtc = new Date();
          todayUtc.setUTCHours(0, 0, 0, 0);

          // Future date (includes today or strictly after today)
          return parsedDate.getTime() >= todayUtc.getTime();
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a future date in YYYY-MM-DD format`;
        },
      },
    });
  };
}

export function IsValidPassengerCount(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidPassengerCount',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const dto = args.object as FlightSearchRequestDto;
          const adults = dto.adults || 0;
          const children = dto.children || 0;
          const infants = dto.infants || 0;

          if (adults + children + infants > 9) {
            return false;
          }
          if (infants > adults) {
            return false;
          }
          return true;
        },
        defaultMessage(args: ValidationArguments) {
          const dto = args.object as FlightSearchRequestDto;
          const adults = dto.adults || 0;
          const children = dto.children || 0;
          const infants = dto.infants || 0;

          if (adults + children + infants > 9) {
            return 'Maximum 9 passengers per search';
          }
          if (infants > adults) {
            return 'Number of infants cannot exceed number of adults';
          }
          return 'Invalid passenger count';
        },
      },
    });
  };
}

export class FlightSearchRequestDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'origin must be a 3-character uppercase IATA airport code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  origin!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'destination must be a 3-character uppercase IATA airport code',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  destination!: string;

  @IsString()
  @IsFutureDateString({ message: 'departureDate must be a future date in YYYY-MM-DD format' })
  departureDate!: string;

  @IsOptional()
  @IsString()
  @IsFutureDateString({ message: 'returnDate must be a future date in YYYY-MM-DD format' })
  returnDate?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'At least 1 adult passenger is required' })
  @Max(9, { message: 'Maximum 9 passengers per search' })
  @IsValidPassengerCount()
  adults!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  children?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  infants?: number;

  @IsOptional()
  @IsString()
  @Matches(/^(economy|premium_economy|business|first)$/, {
    message: 'cabinClass must be one of: economy, premium_economy, business, first',
  })
  cabinClass?: string;
}

export interface CabinMismatchDetail {
  segmentIndex: number;
  leg: 'outbound' | 'return';
  expected: string;
  actual: string;
  route: string;
}

export class FlightSegmentDto {
  carrierCode!: string;
  flightNumber!: string;
  operatingCarrier!: string;
  departureAirport!: string;
  departureTerminal!: string | null;
  departureTime!: string;
  arrivalAirport!: string;
  arrivalTerminal!: string | null;
  arrivalTime!: string;
  duration!: number;
  aircraft!: string | null;
  cabinClass!: 'economy' | 'premium_economy' | 'business' | 'first';
}

/**
 * Flight search offer wire DTO.
 * Retains legacy `duffelOfferId` at the public wire boundary while internal domain models use neutral identifiers.
 */
export class FlightOfferDto {
  id!: string;
  duffelOfferId!: string;
  airline!: string;
  flightNumber!: string;
  departureAirport!: string;
  arrivalAirport!: string;
  departureTime!: string;
  arrivalTime!: string;
  duration!: number;
  stops!: number;
  price!: number;
  currency!: string;
  fareClass!: string | null;
  baggageAllowance!: string | null;
  requestedCabinClass!: 'economy' | 'premium_economy' | 'business' | 'first';
  cabinClassMatch!: 'full' | 'mixed' | 'downgraded';
  cabinMismatchDetails!: CabinMismatchDetail[] | null;
  segments!: FlightSegmentDto[];
  returnSegments!: FlightSegmentDto[] | null;
  matchResult!: FlightMatchResult | null;
}

export class FlightSearchResponseMetaDto {
  totalResults!: number;
  searchHash!: string;
  cached!: boolean;
  requestedCabinClass!: string;
  scoringVersion?: string | null;
  eligibleCount?: number;
  matchLevelCounts?: {
    STRONG: number;
    GOOD: number;
    FAIR: number;
    WEAK: number;
  };
}

export class FlightSearchResponseDto {
  mode: 'MATCHED' | 'RANKED' = 'MATCHED';
  results!: FlightOfferDto[];
  meta!: FlightSearchResponseMetaDto;
}
