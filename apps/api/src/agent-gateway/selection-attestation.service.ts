import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface SelectionAttestationOffer {
  flightOfferId: string;
  duffelOfferId: string;
}

export interface SelectionAttestationPayload {
  userId: string;
  sessionId: string;
  version: number;
  issuedAt: string;
  expiresAt: string;
  offers: SelectionAttestationOffer[];
}

@Injectable()
export class SelectionAttestationService {
  constructor(private configService: ConfigService) {}

  private getSecretKeys(): string[] {
    const candidateKeys = [
      this.configService.get<string>('ATTESTATION_SECRET_CURRENT'),
      this.configService.get<string>('SELECTION_ATTESTATION_SECRET_CURRENT'),
      this.configService.get<string>('ATTESTATION_SECRET_V3'),
      this.configService.get<string>('SELECTION_ATTESTATION_SECRET_V3'),
      this.configService.get<string>('ATTESTATION_SECRET_V2'),
      this.configService.get<string>('SELECTION_ATTESTATION_SECRET_V2'),
      this.configService.get<string>('ATTESTATION_SECRET_V1'),
      this.configService.get<string>('SELECTION_ATTESTATION_SECRET_V1'),
      this.configService.get<string>('ATTESTATION_SECRET'),
      this.configService.get<string>('SELECTION_ATTESTATION_SECRET'),
      this.configService.get<string>('ATTESTATION_SECRET_PREVIOUS'),
      this.configService.get<string>('SELECTION_ATTESTATION_SECRET_PREVIOUS'),
      this.configService.get<string>('CHAT_ATTESTATION_KEY'),
    ];

    const validKeys: string[] = [];
    for (const key of candidateKeys) {
      if (
        key &&
        typeof key === 'string' &&
        key.trim().length > 0 &&
        !validKeys.includes(key.trim())
      ) {
        validKeys.push(key.trim());
      }
    }

    return validKeys;
  }

  private get activeSecretKey(): string {
    const keys = this.getSecretKeys();
    if (keys.length === 0) {
      throw new Error('ATTESTATION_SECRET is not configured');
    }
    return keys[0];
  }

  async signSelectionAttestation(
    userId: string,
    sessionId: string,
    version: number,
    expiresAt: string,
    offers: SelectionAttestationOffer[],
    issuedAt?: string,
  ): Promise<string> {
    const canonicalIssuedAt = issuedAt ?? new Date().toISOString();
    const payload: SelectionAttestationPayload = {
      userId,
      sessionId,
      version,
      issuedAt: canonicalIssuedAt,
      expiresAt,
      offers: offers.map((offer) => ({
        flightOfferId: offer.flightOfferId,
        duffelOfferId: offer.duffelOfferId,
      })),
    };
    const payloadStr = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', this.activeSecretKey)
      .update(payloadStr)
      .digest('hex');

    const base64Payload = Buffer.from(payloadStr, 'utf8').toString('base64url');
    return `sel_v1_${base64Payload}.${signature}`;
  }

  async verifySelectionAttestation(
    attestation: string,
    userId: string,
    sessionId: string,
    version: number,
    offers: SelectionAttestationOffer[],
  ): Promise<boolean> {
    if (!attestation || typeof attestation !== 'string' || !attestation.startsWith('sel_v1_')) {
      throw new UnauthorizedException('Invalid attestation format');
    }

    const remainder = attestation.slice('sel_v1_'.length);
    const parts = remainder.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnauthorizedException('Invalid attestation format');
    }

    const [payloadBase64, signature] = parts;

    let payloadStr: string;
    try {
      payloadStr = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    } catch {
      throw new UnauthorizedException('Invalid attestation format');
    }

    let payload: SelectionAttestationPayload;
    try {
      payload = JSON.parse(payloadStr);
    } catch (e) {
      throw new UnauthorizedException('Invalid attestation payload');
    }

    if (!payload || typeof payload !== 'object') {
      throw new UnauthorizedException('Invalid attestation payload');
    }

    if (payload.userId !== userId) {
      throw new UnauthorizedException('User mismatch');
    }
    if (payload.sessionId !== sessionId) {
      throw new UnauthorizedException('Session mismatch');
    }
    if (payload.version !== version) {
      throw new UnauthorizedException('Version mismatch');
    }

    if (!Array.isArray(payload.offers) || !Array.isArray(offers)) {
      throw new UnauthorizedException('Offers mismatch');
    }
    if (payload.offers.length !== offers.length) {
      throw new UnauthorizedException('Offers mismatch');
    }
    for (let i = 0; i < offers.length; i++) {
      const pOffer = payload.offers[i];
      const expectedOffer = offers[i];
      if (
        !pOffer ||
        !expectedOffer ||
        pOffer.flightOfferId !== expectedOffer.flightOfferId ||
        pOffer.duffelOfferId !== expectedOffer.duffelOfferId
      ) {
        throw new UnauthorizedException('Offers mismatch');
      }
    }

    const expiresAtTime = new Date(payload.expiresAt).getTime();
    if (isNaN(expiresAtTime) || expiresAtTime <= Date.now()) {
      throw new UnauthorizedException('Attestation expired');
    }

    if (payload.issuedAt) {
      const issuedAtTime = new Date(payload.issuedAt).getTime();
      if (isNaN(issuedAtTime)) {
        throw new UnauthorizedException('Invalid attestation payload');
      }
      if (issuedAtTime > Date.now() + 60000) {
        throw new UnauthorizedException('Attestation issued in the future');
      }
      if (issuedAtTime > expiresAtTime) {
        throw new UnauthorizedException('Attestation issuedAt exceeds expiresAt');
      }
    }

    const keys = this.getSecretKeys();
    if (keys.length === 0) {
      throw new Error('ATTESTATION_SECRET is not configured');
    }

    let isValid = false;
    let sigBuffer: Buffer;
    try {
      sigBuffer = Buffer.from(signature, 'hex');
    } catch {
      throw new UnauthorizedException('Invalid signature');
    }

    for (const key of keys) {
      const expectedSignature = crypto.createHmac('sha256', key).update(payloadStr).digest('hex');

      try {
        const expectedBuffer = Buffer.from(expectedSignature, 'hex');
        if (sigBuffer.length === expectedBuffer.length && sigBuffer.length === 32) {
          if (crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
            isValid = true;
            break;
          }
        }
      } catch {
        // continue trying next key in rotation ring
      }
    }

    if (!isValid) {
      throw new UnauthorizedException('Invalid signature');
    }

    return true;
  }
}
