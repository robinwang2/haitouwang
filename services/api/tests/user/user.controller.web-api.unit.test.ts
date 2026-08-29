import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { InMemoryUserStore, USER_STORE } from '../../src/modules/user';
import type { User } from '../../src/modules/user';

const TEST_AUDIENCE = 'haitouwang-api-test';

const domainSchema = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../contracts/schemas/domain.schema.json'), 'utf8'),
) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(domainSchema);

function expectContract(name: 'User' | 'ErrorEnvelope', value: unknown): void {
  const validate = ajv.getSchema(`${domainSchema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Contract validator not found for ${name}.`);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function testSecret(): string {
  return `test-only-auth-${'x'.repeat(32)}`;
}

function signClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', testSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function signToken(userId: string, permissions: string[] = []): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims({ sub: userId, aud: TEST_AUDIENCE, iat: now, exp: now + 300, permissions });
}

function userFixture(userId: string, overrides: Partial<User> = {}): User {
  const now = new Date().toISOString();
  return {
    id: userId,
    email: 'candidate@example.com',
    display_name: 'Candidate Zero',
    locale: 'en-US',
    time_zone: 'America/New_York',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('UserController HTTP surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryUserStore;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'haitouwang-user-'));
    process.env.MATERIALS_DATABASE_PATH = path.join(temporaryDirectory, 'materials.sqlite');
    process.env.AUTH_JWT_SECRET = testSecret();
    process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;

    store = new InMemoryUserStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(USER_STORE)
      .useValue(store)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.MATERIALS_DATABASE_PATH;
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_AUDIENCE;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('returns 401 without an Authorization header', async () => {
    const response = await fetch(`${baseUrl}/v1/users/me`, {
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED', retryable: false } });
  });

  it('rejects an invalid bearer token with 401', async () => {
    const response = await fetch(`${baseUrl}/v1/users/me`, {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('returns the authenticated user with fields matching the contract exactly', async () => {
    const userId = randomUUID();
    const user = userFixture(userId);
    store.users.set(userId, user);

    const response = await fetch(`${baseUrl}/v1/users/me`, {
      headers: { authorization: `Bearer ${signToken(userId)}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expectContract('User', body);
    expect(body).toEqual(user);
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'email',
        'display_name',
        'locale',
        'time_zone',
        'status',
        'version',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('returns 404 RESOURCE_NOT_FOUND when the authenticated principal has no stored user', async () => {
    const userId = randomUUID();

    const response = await fetch(`${baseUrl}/v1/users/me`, {
      headers: { authorization: `Bearer ${signToken(userId)}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
    expect(JSON.stringify(body)).not.toContain('users.invalid');
    expect(JSON.stringify(body)).not.toContain(userId);
  });

  it('only ever returns the requesting tenant own user, never another tenant', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    store.users.set(otherUserId, userFixture(otherUserId, { email: 'other@example.com' }));

    const response = await fetch(`${baseUrl}/v1/users/me`, {
      headers: { authorization: `Bearer ${signToken(userId)}` },
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });
});
