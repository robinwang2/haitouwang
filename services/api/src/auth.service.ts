import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

export interface AuthenticatedPrincipal {
  userId: string;
  permissions: string[];
}

export type AuthErrorCode = 'AUTH_REQUIRED' | 'TOKEN_EXPIRED' | 'FORBIDDEN';

export class AuthError extends Error {
  public constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface JwtHeader {
  alg: string;
  typ: string;
}

interface AccessTokenClaims {
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  permissions: string[];
}

@Injectable()
export class AuthService {
  private readonly secret: string;
  private readonly audience: string;

  public constructor() {
    this.secret = process.env.AUTH_JWT_SECRET ?? '';
    this.audience = process.env.AUTH_JWT_AUDIENCE ?? 'haitouwang-api';
    if (Buffer.byteLength(this.secret, 'utf8') < 32) {
      throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes.');
    }
  }

  public authenticate(authorization: string | undefined): AuthenticatedPrincipal {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
      authorization ?? '',
    );
    if (!match) throw new AuthError('AUTH_REQUIRED', 'A valid bearer access token is required.');

    const [encodedHeader, encodedPayload, encodedSignature] = match[1]!.split('.');
    const header = decodeJson<JwtHeader>(encodedHeader!);
    const claims = decodeJson<AccessTokenClaims>(encodedPayload!);
    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || !claims) {
      throw new AuthError('AUTH_REQUIRED', 'The bearer access token is invalid.');
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const actual = decodeBase64Url(encodedSignature!);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AuthError('AUTH_REQUIRED', 'The bearer access token signature is invalid.');
    }
    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new AuthError('TOKEN_EXPIRED', 'The bearer access token has expired.');
    }
    if (
      claims.aud !== this.audience ||
      !isUuid(claims.sub) ||
      !Number.isInteger(claims.iat) ||
      claims.iat > Math.floor(Date.now() / 1000) + 60 ||
      !Array.isArray(claims.permissions) ||
      !claims.permissions.every((permission) => typeof permission === 'string')
    ) {
      throw new AuthError('FORBIDDEN', 'The bearer access token claims are not accepted.');
    }
    return { userId: claims.sub, permissions: [...new Set(claims.permissions)] };
  }
}

function decodeJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(decodeBase64Url(value).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): Buffer {
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return Buffer.alloc(0);
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
