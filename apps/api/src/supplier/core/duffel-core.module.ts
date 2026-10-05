import { Module } from '@nestjs/common';
import { CacheModule } from '@/cache/cache.module';
import {
  DUFFEL_SDK,
  DUFFEL_SDK_CONFIGURATION,
  duffelSdkConfigurationProvider,
  duffelSdkProvider,
} from './duffel-sdk.provider';
import type { DuffelSdkConfiguration } from './duffel-sdk.provider';
import { DuffelRateBudgetService } from './duffel-rate-budget.service';

export {
  DUFFEL_SDK,
  DUFFEL_SDK_CONFIGURATION,
  duffelSdkProvider,
  DuffelRateBudgetService,
};
export type { DuffelSdkConfiguration };

@Module({
  imports: [CacheModule],
  providers: [duffelSdkConfigurationProvider, duffelSdkProvider, DuffelRateBudgetService],
  exports: [DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION, DuffelRateBudgetService],
})
export class DuffelCoreModule {}
