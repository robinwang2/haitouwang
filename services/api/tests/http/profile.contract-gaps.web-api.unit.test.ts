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
import { InMemoryProfileStore, PROFILE_STORE } from '../../src/modules/profile';

/**
 * HW-6: closes the gaps between contracts/openapi/openapi.json's /v1/goals and
 * /v1/facts definitions and the HTTP coverage HW-5 shipped
 * (tests/profile/profile.controller.web-api.unit.test.ts, 12 cases: missing/invalid
 * auth, aud mismatch, tenant isolation, idempotent replay, missing Idempotency-Key,
 * cross-tenant goal 404). That file is untouched here. This file adds the cases the
 * contract declares but HW-5 didn't exercise: expired token, explicit/over-limit
 * page_size, invalid cursor, POST 400 for a missing required field (as opposed to the
 * Idempotency-Key-shaped 400 HW-5 already covers), and POST 409 for an Idempotency-Key
 * replayed against a different request body.
 */
const TEST_AUDIENCE = 'haitouwang-api-test';

const domainSchema = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../contracts/schemas/domain.schema.json'), 'utf8'),
) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(domainSchema);

function expectContract(name: 'User' | 'Goal' | 'Fact' | 'ErrorEnvelope', value: unknown): void {
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

function signExpiredToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims({
    sub: userId,
    aud: TEST_AUDIENCE,
    iat: now - 3600,
    exp: now - 1,
    permissions: [],
  });
}

function goalBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Backend roles',
    title_keywords: ['Backend Engineer'],
    locations: ['Remote'],
    employment_types: ['full_time'],
    status: 'active',
    ...overrides,
  };
}

function factBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'skill',
    value: { name: 'TypeScript' },
    scope: { use: 'all_goals' },
    source: { type: 'user', reference: 'onboarding-form' },
    ...overrides,
  };
}

describe('ProfileController HTTP surface — contract gaps (HW-6)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryProfileStore;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'haitouwang-profile-gaps-'));
    process.env.MATERIALS_DATABASE_PATH = path.join(temporaryDirectory, 'materials.sqlite');
    process.env.AUTH_JWT_SECRET = testSecret();
    process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;

    store = new InMemoryProfileStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PROFILE_STORE)
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

  async function createGoal(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/v1/goals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `goal-create-${randomUUID()}`,
      },
      body: JSON.stringify(goalBody(overrides)),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  describe('token expiry (contract: 401 Unauthorized covers "expired")', () => {
    it('rejects an expired bearer token with 401 TOKEN_EXPIRED, not a stale-looking 200', async () => {
      const response = await fetch(`${baseUrl}/v1/goals`, {
        headers: { authorization: `Bearer ${signExpiredToken(randomUUID())}` },
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'TOKEN_EXPIRED', retryable: false } });
    });

    it('rejects an expired bearer token on POST /v1/goals with 401 TOKEN_EXPIRED', async () => {
      const response = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${signExpiredToken(randomUUID())}`,
          'content-type': 'application/json',
          'idempotency-key': `goal-create-${randomUUID()}`,
        },
        body: JSON.stringify(goalBody()),
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
    });
  });

  describe('pagination (contract parameters: Cursor, PageSize)', () => {
    it('honors an explicit page_size and reports it back in page.page_size', async () => {
      const userId = randomUUID();
      const token = signToken(userId);
      for (const name of ['Goal A', 'Goal B', 'Goal C']) {
        const created = await createGoal(token, { name });
        expect(created.status).toBe(201);
      }

      const response = await fetch(`${baseUrl}/v1/goals?page_size=2`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page.page).toMatchObject({ page_size: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.page.next_cursor).not.toBeNull();
    });

    it('rejects page_size above the contract maximum (100) with a 4xx, not a 500', async () => {
      const token = signToken(randomUUID());
      const response = await fetch(`${baseUrl}/v1/goals?page_size=101`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });

    it('rejects page_size below the contract minimum (1) with a 4xx, not a 500', async () => {
      const token = signToken(randomUUID());
      const response = await fetch(`${baseUrl}/v1/goals?page_size=0`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });

    it('rejects a cursor that does not resolve within the tenant result set with a 4xx, not a 500', async () => {
      const userId = randomUUID();
      const token = signToken(userId);
      const created = await createGoal(token);
      expect(created.status).toBe(201);

      const response = await fetch(`${baseUrl}/v1/goals?cursor=${randomUUID()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });

  describe('POST 400 for a body-shaped violation (contract: BadRequest — "Validation failed")', () => {
    it('rejects POST /v1/goals with a missing required field (name) with 400 VALIDATION_FAILED', async () => {
      const token = signToken(randomUUID());
      const body = goalBody();
      delete (body as Record<string, unknown>).name;

      const response = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `goal-create-${randomUUID()}`,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expectContract('ErrorEnvelope', responseBody);
      expect(responseBody).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });

    it('rejects POST /v1/facts with a missing required field (source) with 400 VALIDATION_FAILED', async () => {
      const token = signToken(randomUUID());
      const body = factBody();
      delete (body as Record<string, unknown>).source;

      const response = await fetch(`${baseUrl}/v1/facts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `fact-create-${randomUUID()}`,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expectContract('ErrorEnvelope', responseBody);
      expect(responseBody).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });

  describe('POST 409 for an Idempotency-Key replayed against a different request (contract: Conflict)', () => {
    it('rejects a reused Idempotency-Key on POST /v1/goals when the request body differs, with 409', async () => {
      const token = signToken(randomUUID());
      const idempotencyKey = `goal-create-${randomUUID()}`;
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      };

      const first = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers,
        body: JSON.stringify(goalBody({ name: 'First goal' })),
      });
      expect(first.status).toBe(201);
      const firstGoal = await first.json();
      expectContract('Goal', firstGoal);

      const second = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers,
        body: JSON.stringify(goalBody({ name: 'Second, different goal' })),
      });
      expect(second.status).toBe(409);
      const body = await second.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    });

    it('rejects a reused Idempotency-Key on POST /v1/facts when the request body differs, with 409', async () => {
      const token = signToken(randomUUID());
      const idempotencyKey = `fact-create-${randomUUID()}`;
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      };

      const first = await fetch(`${baseUrl}/v1/facts`, {
        method: 'POST',
        headers,
        body: JSON.stringify(factBody({ value: { name: 'TypeScript' } })),
      });
      expect(first.status).toBe(201);
      const firstFact = await first.json();
      expectContract('Fact', firstFact);

      const second = await fetch(`${baseUrl}/v1/facts`, {
        method: 'POST',
        headers,
        body: JSON.stringify(factBody({ value: { name: 'Go' } })),
      });
      expect(second.status).toBe(409);
      const body = await second.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    });
  });
});
