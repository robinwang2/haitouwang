import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from 'node:crypto';

import type { PublicKeyJwk } from './agent.types';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Base64Url(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function secretMatches(candidate: string, expectedHash: string): boolean {
  const candidateHash = Buffer.from(sha256Base64Url(candidate));
  const expected = Buffer.from(expectedHash);
  return candidateHash.length === expected.length && timingSafeEqual(candidateHash, expected);
}

export function publicKeyThumbprint(jwk: PublicKeyJwk): string {
  return sha256Base64Url(
    JSON.stringify({
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    }),
  );
}

export function buildPairingChallengePayload(sessionId: string, challenge: string): string {
  return `${sessionId}.${challenge}`;
}

export function buildAgentProofPayload(
  method: string,
  path: string,
  nonce: string,
  body: unknown,
): string {
  const bodyDigest = sha256Base64Url(canonicalJson(body));
  return `${method.toUpperCase()}\n${path}\n${nonce}\n${bodyDigest}`;
}

export function verifyDeviceSignature(
  jwk: PublicKeyJwk,
  payload: string,
  signature: string,
): boolean {
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'base64url');
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    return (
      verify('sha256', Buffer.from(payload), publicKey, signatureBytes) ||
      verify(
        'sha256',
        Buffer.from(payload),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signatureBytes,
      )
    );
  } catch {
    return false;
  }
}

export function signControlValue(signingKey: Uint8Array, value: unknown): string {
  return createHmac('sha256', signingKey).update(canonicalJson(value)).digest('base64url');
}
