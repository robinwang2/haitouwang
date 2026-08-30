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

function signTokenWithAudience(userId: string, audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims({ sub: userId, aud: audience, iat: now, exp: now + 300, permissions: [] });
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

describe('ProfileController HTTP surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryProfileStore;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'haitouwang-profile-'));
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

  const ENDPOINTS: Array<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'GET', path: '/v1/goals' },
    { method: 'POST', path: '/v1/goals' },
    { method: 'GET', path: '/v1/facts' },
    { method: 'POST', path: '/v1/facts' },
  ];

  it.each(ENDPOINTS)(
    'returns 401 without an Authorization header for $method $path',
    async ({ method, path: routePath }) => {
      const response = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED', retryable: false } });
    },
  );

  it('rejects an invalid bearer token with 401', async () => {
    const response = await fetch(`${baseUrl}/v1/goals`, {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('rejects a well-formed token with the wrong audience as 401, not 403', async () => {
    // RFC 6750: invalid_token (bad signature, expiry, wrong claims incl. audience) is
    // always 401. This must not degrade to 403 just because the token parses fine and
    // only fails the audience check.
    const response = await fetch(`${baseUrl}/v1/goals`, {
      headers: { authorization: `Bearer ${signTokenWithAudience(randomUUID(), 'wrong-audience')}` },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(typeof body.error.code).toBe('string');
  });

  it('rejects a wrong-audience token on POST /v1/goals as 401, not 403', async () => {
    const response = await fetch(`${baseUrl}/v1/goals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signTokenWithAudience(randomUUID(), 'wrong-audience')}`,
        'content-type': 'application/json',
        'idempotency-key': `goal-create-${randomUUID()}`,
      },
      body: JSON.stringify(goalBody()),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
  });

  it('creates and lists goals scoped to the authenticated tenant only', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const token = `Bearer ${signToken(userId)}`;

    const createResponse = await fetch(`${baseUrl}/v1/goals`, {
      method: 'POST',
      headers: {
        authorization: token,
        'content-type': 'application/json',
        'idempotency-key': `goal-create-${randomUUID()}`,
      },
      body: JSON.stringify(goalBody()),
    });
    expect(createResponse.status).toBe(201);
    const goal = await createResponse.json();
    expectContract('Goal', goal);
    expect(goal).toMatchObject({ user_id: userId, name: 'Backend roles', version: 1 });
    expect(goal).not.toHaveProperty('user_id_from_query');

    await fetch(`${baseUrl}/v1/goals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(otherUserId)}`,
        'content-type': 'application/json',
        'idempotency-key': `goal-create-${randomUUID()}`,
      },
      body: JSON.stringify(goalBody({ name: 'Other tenant goal' })),
    });

    const listResponse = await fetch(`${baseUrl}/v1/goals`, { headers: { authorization: token } });
    expect(listResponse.status).toBe(200);
    const page = await listResponse.json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: goal.id, user_id: userId });
    expect(page.page).toMatchObject({ page_size: 25, next_cursor: null });
  });

  it('replays the same goal id for a repeated Idempotency-Key and stores one record', async () => {
    const userId = randomUUID();
    const idempotencyKey = `goal-create-${randomUUID()}`;
    const body = JSON.stringify(goalBody());
    const headers = {
      authorization: `Bearer ${signToken(userId)}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    };

    const first = await fetch(`${baseUrl}/v1/goals`, { method: 'POST', headers, body });
    expect(first.status).toBe(201);
    const firstGoal = await first.json();

    const second = await fetch(`${baseUrl}/v1/goals`, { method: 'POST', headers, body });
    expect(second.status).toBe(201);
    const secondGoal = await second.json();

    expect(secondGoal.id).toBe(firstGoal.id);
    expect(store.goals.size).toBe(1);
    const listResponse = await fetch(`${baseUrl}/v1/goals`, {
      headers: { authorization: headers.authorization },
    });
    const page = await listResponse.json();
    expect(page.items).toHaveLength(1);
  });

  it('rejects POST /v1/goals with a missing or malformed Idempotency-Key', async () => {
    const response = await fetch(`${baseUrl}/v1/goals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(randomUUID())}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(goalBody()),
    });
    expect(response.status).toBe(400);
    const responseBody = await response.json();
    expectContract('ErrorEnvelope', responseBody);
    expect(responseBody).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('creates and lists facts scoped to the authenticated tenant only', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const token = `Bearer ${signToken(userId)}`;

    const createResponse = await fetch(`${baseUrl}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: token,
        'content-type': 'application/json',
        'idempotency-key': `fact-create-${randomUUID()}`,
      },
      body: JSON.stringify(factBody()),
    });
    expect(createResponse.status).toBe(201);
    const fact = await createResponse.json();
    expectContract('Fact', fact);
    expect(fact).toMatchObject({ user_id: userId, kind: 'skill', status: 'pending_confirmation' });

    await fetch(`${baseUrl}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(otherUserId)}`,
        'content-type': 'application/json',
        'idempotency-key': `fact-create-${randomUUID()}`,
      },
      body: JSON.stringify(factBody({ value: { name: 'Other tenant fact' } })),
    });

    const listResponse = await fetch(`${baseUrl}/v1/facts?status=pending_confirmation`, {
      headers: { authorization: token },
    });
    expect(listResponse.status).toBe(200);
    const page = await listResponse.json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: fact.id, user_id: userId });
    expect(page.items.every((item: { user_id: string }) => item.user_id === userId)).toBe(true);
  });

  it("returns 404 RESOURCE_NOT_FOUND when a fact scopes itself to another tenant's goal", async () => {
    // The five profile endpoints in this ticket (users/me, goals, facts) have no
    // single-resource GET by id (GET /v1/goals/{goalId} / GET /v1/facts/{factId} are not
    // defined in contracts/openapi/openapi.json), so cross-tenant isolation is exercised
    // here through the one HTTP-reachable path that resolves another resource by id on the
    // caller's behalf: POST /v1/facts validates scope.goal_ids against the *caller's* tenant
    // (ProfileService#requireOwned), so referencing someone else's goal 404s exactly the way
    // a direct cross-tenant GET would.
    const ownerId = randomUUID();
    const attackerId = randomUUID();

    const goalResponse = await fetch(`${baseUrl}/v1/goals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(ownerId)}`,
        'content-type': 'application/json',
        'idempotency-key': `goal-create-${randomUUID()}`,
      },
      body: JSON.stringify(goalBody()),
    });
    expect(goalResponse.status).toBe(201);
    const ownerGoal = await goalResponse.json();

    const factResponse = await fetch(`${baseUrl}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(attackerId)}`,
        'content-type': 'application/json',
        'idempotency-key': `fact-create-${randomUUID()}`,
      },
      body: JSON.stringify(
        factBody({ scope: { use: 'selected_goals', goal_ids: [ownerGoal.id] } }),
      ),
    });

    expect(factResponse.status).toBe(404);
    const body = await factResponse.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });
});
