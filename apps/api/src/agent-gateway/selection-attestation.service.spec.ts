import { createHmac } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { SelectionAttestationService } from './selection-attestation.service';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

describe('SelectionAttestationService', () => {
  let service: SelectionAttestationService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SelectionAttestationService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'ATTESTATION_SECRET') return 'super-secret-key-for-attestation';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SelectionAttestationService>(SelectionAttestationService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('T044 selection-attestation wire bytes', () => {
    it('pins sel_v1 JSON bytes, ordered legacy IDs, base64url payload, and HMAC', async (): Promise<void> => {
      const issuedAt = '2026-09-30T12:00:00.000Z';
      const expiresAt = '2026-09-30T12:15:00.000Z';
      const offers = [
        { flightOfferId: 'fo-1', duffelOfferId: 'off-1' },
        { flightOfferId: 'fo-2', duffelOfferId: 'off-2' },
      ];
      const expectedJson =
        '{"userId":"user-1","sessionId":"session-1","version":7,' +
        '"issuedAt":"2026-09-30T12:00:00.000Z",' +
        '"expiresAt":"2026-09-30T12:15:00.000Z",' +
        '"offers":[{"flightOfferId":"fo-1","duffelOfferId":"off-1"},' +
        '{"flightOfferId":"fo-2","duffelOfferId":"off-2"}]}';
      const reversedJson = JSON.stringify({
        userId: 'user-1',
        sessionId: 'session-1',
        version: 7,
        issuedAt,
        expiresAt,
        offers: [...offers].reverse(),
      });
      const expectedToken =
        'sel_v1_eyJ1c2VySWQiOiJ1c2VyLTEiLCJzZXNzaW9uSWQiOiJzZXNzaW9uLTEiLCJ2ZXJzaW9uIjo3LCJpc3N1ZWRBdCI6IjIwMjYtMDktMzBUMTI6MDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwMjYtMDktMzBUMTI6MTU6MDAuMDAwWiIsIm9mZmVycyI6W3siZmxpZ2h0T2ZmZXJJZCI6ImZvLTEiLCJkdWZmZWxPZmZlcklkIjoib2ZmLTEifSx7ImZsaWdodE9mZmVySWQiOiJmby0yIiwiZHVmZmVsT2ZmZXJJZCI6Im9mZi0yIn1dfQ.' +
        '3852a121985c83fc9dcb7f1380236c8b3b53d5cd5bc8eb76e4681b79892d3590';

      expect(reversedJson).not.toBe(expectedJson);
      const token = await service.signSelectionAttestation(
        'user-1',
        'session-1',
        7,
        expiresAt,
        offers,
        issuedAt,
      );
      const tokenBody = token.slice('sel_v1_'.length);
      const separator = tokenBody.indexOf('.');
      const encoded = tokenBody.slice(0, separator);
      const signature = tokenBody.slice(separator + 1);

      expect(token).toBe(expectedToken);
      expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(expectedJson);
      // Approved by the user: derive this oracle key from the injected test fixture so the digest check has no hardcoded key.
      const expectedHmacKey: unknown = configService.get<unknown>('ATTESTATION_SECRET');
      if (typeof expectedHmacKey !== 'string') {
        throw new Error('Expected ATTESTATION_SECRET test fixture to be configured');
      }
      expect(signature).toBe(
        createHmac('sha256', expectedHmacKey)
          .update(expectedJson, 'utf8')
          .digest('hex'),
      );
    });

    it('rejects a supplier-named identity substituted into the signed payload', async (): Promise<void> => {
      const issuedAt = new Date(Date.now() - 5000).toISOString();
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: 'fo-1', duffelOfferId: 'off-1' }];
      const token = await service.signSelectionAttestation(
        'user-1',
        'session-1',
        7,
        expiresAt,
        offers,
        issuedAt,
      );
      const tokenBody = token.slice('sel_v1_'.length);
      const separator = tokenBody.indexOf('.');
      const encoded = tokenBody.slice(0, separator);
      const signature = tokenBody.slice(separator + 1);
      const decodedJson = Buffer.from(encoded, 'base64url').toString('utf8');
      const supplierNamedJson = decodedJson.replace(
        '"duffelOfferId":"off-1"',
        '"supplierOfferId":"off-1"',
      );
      const substitutedAttestation = `sel_v1_${Buffer.from(supplierNamedJson, 'utf8').toString('base64url')}.${signature}`;

      expect(supplierNamedJson).not.toBe(decodedJson);
      await expect(
        service.verifySelectionAttestation(
          substitutedAttestation,
          'user-1',
          'session-1',
          7,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });
  });

  describe('signSelectionAttestation & verifySelectionAttestation success roundtrip', () => {
    it('should sign and verify an ordered-offer attestation with default issuedAt', async () => {
      const userId = 'user-123';
      const sessionId = 'session-456';
      const version = 3;
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
      ];

      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      expect(attestation).toBeDefined();
      expect(attestation).toMatch(/^sel_v1_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/);

      const verified = await service.verifySelectionAttestation(
        attestation,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });

    it('should sign and verify an ordered-offer attestation with custom issuedAt', async () => {
      const userId = 'user-123';
      const sessionId = 'session-456';
      const version = 3;
      const issuedAt = new Date(Date.now() - 5000).toISOString();
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
        issuedAt,
      );

      const verified = await service.verifySelectionAttestation(
        attestation,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });
  });

  describe('tampered offers rejection', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const originalOffers = [
      { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
      { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
    ];

    it('should reject attestation when flightOfferId is modified', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const modifiedOffers = [
        { flightOfferId: 'offer-modified', duffelOfferId: 'duff-1' },
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, modifiedOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation when duffelOfferId is modified', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const modifiedOffers = [
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-modified' },
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, modifiedOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation when offer order is swapped', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const swappedOffers = [
        { flightOfferId: 'offer-2', duffelOfferId: 'duff-2' },
        { flightOfferId: 'offer-1', duffelOfferId: 'duff-1' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, swappedOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation with extra offers in expected parameter', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const extraOffers = [
        ...originalOffers,
        { flightOfferId: 'offer-3', duffelOfferId: 'duff-3' },
      ];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, extraOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });

    it('should reject attestation with missing offers in expected parameter', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        originalOffers,
      );

      const missingOffers = [originalOffers[0]];

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, missingOffers),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });
  });

  describe('mismatched parameters rejection', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject mismatched userId', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, 'wrong-user', sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('User mismatch'));
    });

    it('should reject mismatched sessionId', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, 'wrong-session', version, offers),
      ).rejects.toThrow(new UnauthorizedException('Session mismatch'));
    });

    it('should reject mismatched version', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version + 1, offers),
      ).rejects.toThrow(new UnauthorizedException('Version mismatch'));
    });
  });

  describe('expiration and timestamp validation', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject an expired attestation', async () => {
      const expiresAt = new Date(Date.now() - 1000).toISOString();
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Attestation expired'));
    });

    it('should reject attestation if issuedAt exceeds clock skew (> 60s in the future)', async () => {
      const futureIssuedAt = new Date(Date.now() + 120000).toISOString();
      const expiresAt = new Date(Date.now() + 300000).toISOString();
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
        futureIssuedAt,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Attestation issued in the future'));
    });

    it('should reject attestation if issuedAt is after expiresAt', async () => {
      const expiresAt = new Date(Date.now() + 10000).toISOString();
      const issuedAt = new Date(Date.now() + 20000).toISOString();
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
        issuedAt,
      );

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Attestation issuedAt exceeds expiresAt'));
    });
  });

  describe('malformed format and invalid payload rejection', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 1;
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject invalid attestation prefix or non-string format', async () => {
      await expect(
        service.verifySelectionAttestation(
          'wrong_prefix_base64.sig',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));

      await expect(
        service.verifySelectionAttestation('', userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));

      await expect(
        service.verifySelectionAttestation(
          'sel_v1_onlypayloadwithoutdot',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));

      await expect(
        service.verifySelectionAttestation(
          'sel_v1_payload.sig.extrapart',
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation format'));
    });

    it('should reject malformed non-JSON payload', async () => {
      const invalidJsonBase64 = Buffer.from('{not-valid-json').toString('base64url');
      const malformedAttestation = `sel_v1_${invalidJsonBase64}.validsignature`;

      await expect(
        service.verifySelectionAttestation(
          malformedAttestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation payload'));
    });

    it('should reject non-object JSON payload', async () => {
      const nonObjectJsonBase64 = Buffer.from(JSON.stringify('plain-string')).toString('base64url');
      const attestation = `sel_v1_${nonObjectJsonBase64}.validsignature`;

      await expect(
        service.verifySelectionAttestation(attestation, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Invalid attestation payload'));
    });
  });

  describe('signature validation & timingSafeEqual', () => {
    const userId = 'user-123';
    const sessionId = 'session-456';
    const version = 3;
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    const offers = [{ flightOfferId: 'offer-1', duffelOfferId: 'duff-1' }];

    it('should reject invalid or corrupted signature', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const [prefixAndPayload, validSig] = attestation.split('.');
      const corruptedSig = validSig.slice(0, -2) + (validSig.endsWith('0') ? '1' : '0');
      const corruptedAttestation = `${prefixAndPayload}.${corruptedSig}`;

      await expect(
        service.verifySelectionAttestation(
          corruptedAttestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid signature'));
    });

    it('should reject signature with wrong byte length', async () => {
      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const [prefixAndPayload] = attestation.split('.');
      const shortSig = '1234abcd';
      const corruptedAttestation = `${prefixAndPayload}.${shortSig}`;

      await expect(
        service.verifySelectionAttestation(
          corruptedAttestation,
          userId,
          sessionId,
          version,
          offers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Invalid signature'));
    });

    it('should verify signature using constant-time timingSafeEqual comparison', async () => {
      const crypto = require('crypto');
      const timingSafeEqualSpy = jest.spyOn(crypto, 'timingSafeEqual');

      const attestation = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const verified = await service.verifySelectionAttestation(
        attestation,
        userId,
        sessionId,
        version,
        offers,
      );

      expect(verified).toBe(true);
      expect(timingSafeEqualSpy).toHaveBeenCalled();
      timingSafeEqualSpy.mockRestore();
    });
  });

  describe('missing ATTESTATION_SECRET configuration', () => {
    it('should throw Error on sign if ATTESTATION_SECRET is not configured', async () => {
      jest.spyOn(configService, 'get').mockReturnValue(null);

      await expect(
        service.signSelectionAttestation(
          'user-1',
          'session-1',
          1,
          new Date(Date.now() + 60000).toISOString(),
          [{ flightOfferId: 'f1', duffelOfferId: 'd1' }],
        ),
      ).rejects.toThrow('ATTESTATION_SECRET is not configured');
    });

    it('should throw Error on verify if ATTESTATION_SECRET is not configured', async () => {
      const attestation = await service.signSelectionAttestation(
        'user-1',
        'session-1',
        1,
        new Date(Date.now() + 60000).toISOString(),
        [{ flightOfferId: 'f1', duffelOfferId: 'd1' }],
      );

      jest.spyOn(configService, 'get').mockReturnValue(null);

      await expect(
        service.verifySelectionAttestation(attestation, 'user-1', 'session-1', 1, [
          { flightOfferId: 'f1', duffelOfferId: 'd1' },
        ]),
      ).rejects.toThrow('ATTESTATION_SECRET is not configured');
    });
  });

  describe('key rotation and rotation ring verification', () => {
    const userId = 'user-rot-1';
    const sessionId = 'session-rot-1';
    const version = 1;
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const offers = [{ flightOfferId: 'f1', duffelOfferId: 'd1' }];

    it('should sign with active V2 key and verify cleanly with V2', async () => {
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'ATTESTATION_SECRET_V2') return 'secret-v2-active';
        if (key === 'ATTESTATION_SECRET_V1') return 'secret-v1-old';
        return null;
      });

      const attestationV2 = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      const verified = await service.verifySelectionAttestation(
        attestationV2,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });

    it('should verify attestations signed with Key V1 cleanly after Key V2 is introduced', async () => {
      // Step 1: Sign attestation when only Key V1 is present
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'ATTESTATION_SECRET_V1') return 'secret-v1-old';
        return null;
      });

      const attestationV1 = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      // Step 2: Introduce Key V2 as the active key while retaining Key V1 in rotation ring
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'ATTESTATION_SECRET_V2') return 'secret-v2-active';
        if (key === 'ATTESTATION_SECRET_V1') return 'secret-v1-old';
        return null;
      });

      // Verification of V1 attestation should still succeed
      const verified = await service.verifySelectionAttestation(
        attestationV1,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });

    it('should support fallback across alternative ring variables (e.g. SELECTION_ATTESTATION_SECRET, CHAT_ATTESTATION_KEY)', async () => {
      // Sign with CHAT_ATTESTATION_KEY
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'CHAT_ATTESTATION_KEY') return 'chat-attestation-legacy-key';
        return null;
      });

      const attestationLegacy = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      // Verify with rotation ring containing SELECTION_ATTESTATION_SECRET_V2 and CHAT_ATTESTATION_KEY
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'SELECTION_ATTESTATION_SECRET_V2') return 'new-selection-secret-v2';
        if (key === 'CHAT_ATTESTATION_KEY') return 'chat-attestation-legacy-key';
        return null;
      });

      const verified = await service.verifySelectionAttestation(
        attestationLegacy,
        userId,
        sessionId,
        version,
        offers,
      );
      expect(verified).toBe(true);
    });

    it('should reject attestation if signed with old key that was removed from rotation ring', async () => {
      // Sign with V1 key
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'ATTESTATION_SECRET_V1') return 'secret-v1-revoked';
        return null;
      });

      const attestationV1 = await service.signSelectionAttestation(
        userId,
        sessionId,
        version,
        expiresAt,
        offers,
      );

      // Rotate to V2 only (V1 removed)
      jest.spyOn(configService, 'get').mockImplementation((key: string) => {
        if (key === 'ATTESTATION_SECRET_V2') return 'secret-v2-active';
        return null;
      });

      await expect(
        service.verifySelectionAttestation(attestationV1, userId, sessionId, version, offers),
      ).rejects.toThrow(new UnauthorizedException('Invalid signature'));
    });
  });
});
