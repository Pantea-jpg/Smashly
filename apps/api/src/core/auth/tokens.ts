import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import type { Role } from '@tw/contracts';
import { errors as joseErrors, jwtVerify, type JWTHeaderParameters, SignJWT } from 'jose';
import type { Env } from '../../config/env';
import { AppError } from '../errors/app-error';

const ALG = 'EdDSA';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  userId: string;
  role: Role;
  /** Refresh-token family (one per login session). */
  sessionId: string;
  tokenVersion: number;
}

export type TokenConfig = Pick<
  Env,
  | 'JWT_PRIVATE_KEY'
  | 'JWT_KEY_ID'
  | 'JWT_PREVIOUS_PUBLIC_KEY'
  | 'JWT_PREVIOUS_KEY_ID'
  | 'JWT_ISSUER'
  | 'JWT_AUDIENCE'
  | 'ACCESS_TOKEN_TTL_SECONDS'
>;

function decodePem(base64: string, name: string): string {
  const pem = Buffer.from(base64, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN')) {
    throw new Error(`${name} must be a base64-encoded PEM key`);
  }
  return pem;
}

/**
 * Signs and verifies short-lived access tokens (EdDSA / Ed25519).
 * Verification accepts the current key and, during rotation, the previous one (by `kid`).
 */
export class TokenService {
  private readonly signingKey: KeyObject;
  private readonly verificationKeys: Map<string, KeyObject>;

  constructor(
    private readonly config: TokenConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.signingKey = createPrivateKey(decodePem(config.JWT_PRIVATE_KEY, 'JWT_PRIVATE_KEY'));
    if (this.signingKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('JWT_PRIVATE_KEY must be an Ed25519 key');
    }
    this.verificationKeys = new Map([[config.JWT_KEY_ID, createPublicKey(this.signingKey)]]);
    if (config.JWT_PREVIOUS_PUBLIC_KEY && config.JWT_PREVIOUS_KEY_ID) {
      this.verificationKeys.set(
        config.JWT_PREVIOUS_KEY_ID,
        createPublicKey(decodePem(config.JWT_PREVIOUS_PUBLIC_KEY, 'JWT_PREVIOUS_PUBLIC_KEY')),
      );
    }
  }

  get accessTokenTtlSeconds(): number {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const expiresAtSeconds = issuedAt + this.config.ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({
      role: claims.role,
      sid: claims.sessionId,
      tv: claims.tokenVersion,
    })
      .setProtectedHeader({ alg: ALG, kid: this.config.JWT_KEY_ID, typ: 'at+jwt' })
      .setSubject(claims.userId)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.signingKey);
    return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  /** Throws AppError TOKEN_EXPIRED or UNAUTHENTICATED; never leaks verification details. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims & { expiresAt: Date }> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header: JWTHeaderParameters) => {
          const key = header.kid ? this.verificationKeys.get(header.kid) : undefined;
          if (!key) throw new AppError('UNAUTHENTICATED', 'Unknown signing key');
          return key;
        },
        {
          algorithms: [ALG],
          issuer: this.config.JWT_ISSUER,
          audience: this.config.JWT_AUDIENCE,
          typ: 'at+jwt',
          currentDate: this.now(),
          requiredClaims: ['sub', 'exp', 'iat'],
        },
      );
      const { sub, role, sid, tv, exp } = payload;
      if (
        typeof sub !== 'string' ||
        // User ids are UUIDs; anything else would reach the database query as invalid input
        // (found by the Phase 9 auth fuzzing: a 500 instead of a 401).
        !UUID.test(sub) ||
        (role !== 'ADMIN' && role !== 'USER') ||
        typeof sid !== 'string' ||
        typeof tv !== 'number'
      ) {
        throw new AppError('UNAUTHENTICATED', 'Malformed access token');
      }
      return {
        userId: sub,
        role,
        sessionId: sid,
        tokenVersion: tv,
        expiresAt: new Date((exp ?? 0) * 1000),
      };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw new AppError('TOKEN_EXPIRED', 'Access token expired');
      }
      if (error instanceof AppError) throw error;
      throw new AppError('UNAUTHENTICATED', 'Invalid access token');
    }
  }
}

/** 256-bit random token, URL-safe. Used for refresh, password-reset and verification tokens. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only hashes of opaque tokens are stored; a database leak does not yield usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
