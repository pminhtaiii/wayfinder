import { Test, TestingModule } from '@nestjs/testing';
import { Injectable, Inject, Module } from '@nestjs/common';
import { Duffel } from '@duffel/api';
import {
  DuffelCoreModule,
  DUFFEL_SDK,
  DUFFEL_SDK_CONFIGURATION,
} from './duffel-core.module';
import type { DuffelSdkConfiguration } from './duffel-core.module';

@Injectable()
class ServiceConsumerA {
  constructor(@Inject(DUFFEL_SDK) public readonly sdk: Duffel) {}
}

@Injectable()
class ServiceConsumerB {
  constructor(@Inject(DUFFEL_SDK) public readonly sdk: Duffel) {}
}

@Injectable()
class UnrelatedSdkConsumer {
  constructor(@Inject(DUFFEL_SDK) public readonly sdk: unknown) {}
}

@Module({ providers: [UnrelatedSdkConsumer] })
class UnrelatedSdkModule {}

describe('DuffelCoreModule', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('SDK Singleton Provider', () => {
    it('creates exactly one SDK instance and shares it across injections when DUFFEL_SDK is resolved', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';
      delete process.env.DUFFEL_API_URL;

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [DuffelCoreModule],
        providers: [ServiceConsumerA, ServiceConsumerB],
      }).compile();

      const sdkInstance = moduleRef.get<Duffel>(DUFFEL_SDK);
      const consumerA = moduleRef.get<ServiceConsumerA>(ServiceConsumerA);
      const consumerB = moduleRef.get<ServiceConsumerB>(ServiceConsumerB);

      expect(sdkInstance).toBeDefined();
      expect(sdkInstance).toBeInstanceOf(Duffel);
      expect(consumerA.sdk).toBe(sdkInstance);
      expect(consumerB.sdk).toBe(sdkInstance);
      expect(consumerA.sdk).toBe(consumerB.sdk);
    });

    it('does not expose DUFFEL_SDK to an unrelated module in the same application', async (): Promise<void> => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';

      await expect(
        Test.createTestingModule({
          imports: [DuffelCoreModule, UnrelatedSdkModule],
        }).compile(),
      ).rejects.toThrow(/DUFFEL_SDK/);
    });

    it('exports the validated transport configuration used by the SDK', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = ' test_duffel_token ';
      process.env.DUFFEL_API_URL = 'http://localhost:4000/v2/';

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [DuffelCoreModule],
      }).compile();

      expect(moduleRef.get<DuffelSdkConfiguration>(DUFFEL_SDK_CONFIGURATION)).toEqual({
        token: 'test_duffel_token',
        basePath: 'http://localhost:4000/v2',
      });
      expect(moduleRef.get<Duffel>(DUFFEL_SDK)).toBeInstanceOf(Duffel);
      await moduleRef.close();
    });
  });

  describe('Token Validation', () => {
    it('throws a clear configuration error at startup when DUFFEL_ACCESS_TOKEN is missing', async () => {
      delete process.env.DUFFEL_ACCESS_TOKEN;

      await expect(
        Test.createTestingModule({
          imports: [DuffelCoreModule],
        }).compile(),
      ).rejects.toThrow(/DUFFEL_ACCESS_TOKEN/);
    });

    it('throws a clear configuration error at startup when DUFFEL_ACCESS_TOKEN is empty string', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = '';

      await expect(
        Test.createTestingModule({
          imports: [DuffelCoreModule],
        }).compile(),
      ).rejects.toThrow(/DUFFEL_ACCESS_TOKEN/);
    });

    it('throws a clear configuration error at startup when DUFFEL_ACCESS_TOKEN is whitespace only', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = '   ';

      await expect(
        Test.createTestingModule({
          imports: [DuffelCoreModule],
        }).compile(),
      ).rejects.toThrow(/DUFFEL_ACCESS_TOKEN/);
    });
  });

  describe('Mock URL override (DUFFEL_API_URL)', () => {
    it('configures SDK with custom base path when DUFFEL_API_URL is set to http://localhost:4000', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';
      process.env.DUFFEL_API_URL = 'http://localhost:4000';

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [DuffelCoreModule],
      }).compile();

      const sdk = moduleRef.get<Duffel>(DUFFEL_SDK);
      const client = (sdk as unknown as { client: { basePath: string } }).client;
      expect(client.basePath).toBe('http://localhost:4000');
    });

    it('configures SDK with custom base path when DUFFEL_API_URL is set to http://mock.duffel.local/v2', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';
      process.env.DUFFEL_API_URL = 'http://mock.duffel.local/v2';

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [DuffelCoreModule],
      }).compile();

      const sdk = moduleRef.get<Duffel>(DUFFEL_SDK);
      const client = (sdk as unknown as { client: { basePath: string } }).client;
      expect(client.basePath).toBe('http://mock.duffel.local/v2');
    });

    it('normalizes trailing slashes in DUFFEL_API_URL', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';
      process.env.DUFFEL_API_URL = 'http://localhost:4000/';

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [DuffelCoreModule],
      }).compile();

      const sdk = moduleRef.get<Duffel>(DUFFEL_SDK);
      const client = (sdk as unknown as { client: { basePath: string } }).client;
      expect(client.basePath).toBe('http://localhost:4000');
    });
  });

  describe('Malformed URL fast-fail', () => {
    it('throws immediately during module initialization for invalid/malformed URL syntax', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';
      process.env.DUFFEL_API_URL = 'not-a-url';

      await expect(
        Test.createTestingModule({
          imports: [DuffelCoreModule],
        }).compile(),
      ).rejects.toThrow();
    });

    it('throws immediately during module initialization for unsupported protocols like ftp://', async () => {
      process.env.DUFFEL_ACCESS_TOKEN = 'test_duffel_token';
      process.env.DUFFEL_API_URL = 'ftp://mock.duffel.local';

      await expect(
        Test.createTestingModule({
          imports: [DuffelCoreModule],
        }).compile(),
      ).rejects.toThrow(/Unsupported DUFFEL_API_URL protocol/);
    });
  });
});
