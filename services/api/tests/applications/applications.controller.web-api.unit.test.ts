import { createHmac } from 'node:crypto';
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
import {
  APPLICATIONS_STORE,
  InMemoryApplicationsStore,
  type Application,
  type ApplicationStatus,
  type ManualApplicationTask,
} from '../../src/modules/applications';

const TEST_AUDIENCE = 'haitouwang-api-test';
const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';

const domainSchema = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../contracts/schemas/domain.schema.json'), 'utf8'),
) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(domainSchema);

function expectContract(name: 'Application' | 'Task' | 'ErrorEnvelope', value: unknown): void {
  const validate = ajv.getSchema(`${domainSchema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Contract validator not found for ${name}.`);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function testSecret(): string {
  return `test-only-auth-${'x'.repeat(32)}`;
}

function signToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, aud: TEST_AUDIENCE, iat: now, exp: now + 300, permissions: [] }),
  ).toString('base64url');
  const signature = createHmac('sha256', testSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function applicationFixture(
  id: string,
  userId: string,
  status: ApplicationStatus = 'draft',
): Application {
  const now = '2026-08-29T00:00:00.000Z';
  return {
    id,
    user_id: userId,
    job_id: '20000000-0000-4000-8000-000000000001',
    goal_id: '30000000-0000-4000-8000-000000000001',
    material_ids: ['40000000-0000-4000-8000-000000000001'],
    status,
    submission_idempotency_key: `submission:${id}`,
    evidence: [],
    timeline: [],
    version: 1,
    created_at: now,
    updated_at: now,
  };
}

function taskFixture(id: string, userId: string, applicationId: string): ManualApplicationTask {
  const now = '2026-08-29T00:00:00.000Z';
  return {
    id,
    user_id: userId,
    type: 'manual_application',
    status: 'requires_human',
    resource: { type: 'application', id: applicationId, version: 1 },
    attempt: 0,
    max_attempts: 1,
    manual_reason: 'captcha',
    package: {
      target_url: 'https://careers.example.test/apply',
      material_refs: [],
      answer_refs: [],
      risk_codes: [],
      unresolved_items: ['captcha'],
      recovery_action: 'user_complete_locally',
    },
    created_at: now,
    updated_at: now,
  };
}

describe('ApplicationsController HTTP read surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryApplicationsStore;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'haitouwang-applications-http-'));
    process.env.MATERIALS_DATABASE_PATH = path.join(temporaryDirectory, 'materials.sqlite');
    process.env.AUTH_JWT_SECRET = testSecret();
    process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;

    store = new InMemoryApplicationsStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APPLICATIONS_STORE)
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

  it.each(['/v1/applications', '/v1/tasks'])(
    'returns 401 without an Authorization header for GET %s',
    async (routePath) => {
      const response = await fetch(`${baseUrl}${routePath}`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    },
  );

  it('returns contract applications for only the authenticated tenant', async () => {
    const ownId = '50000000-0000-4000-8000-000000000001';
    const otherId = '50000000-0000-4000-8000-000000000002';
    await store.saveApplication(USER_A, applicationFixture(ownId, USER_A));
    await store.saveApplication(USER_B, applicationFixture(otherId, USER_B));

    const response = await fetch(`${baseUrl}/v1/applications`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Application[]; page: unknown };
    expect(Object.keys(body).sort()).toEqual(['items', 'page']);
    expect(body.items.map((item) => item.id)).toEqual([ownId]);
    expect(body.items.every((item) => item.user_id === USER_A)).toBe(true);
    expectContract('Application', body.items[0]);
  });

  it('returns contract tasks for only the authenticated tenant', async () => {
    const ownId = '60000000-0000-4000-8000-000000000001';
    const otherId = '60000000-0000-4000-8000-000000000002';
    await store.saveManualTask(
      USER_A,
      taskFixture(ownId, USER_A, '50000000-0000-4000-8000-000000000001'),
    );
    await store.saveManualTask(
      USER_B,
      taskFixture(otherId, USER_B, '50000000-0000-4000-8000-000000000002'),
    );

    const response = await fetch(`${baseUrl}/v1/tasks`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      page: unknown;
    };
    expect(Object.keys(body).sort()).toEqual(['items', 'page']);
    expect(body.items.map((item) => item.id)).toEqual([ownId]);
    expect(body.items.every((item) => item.user_id === USER_A)).toBe(true);
    expect(body.items[0]).not.toHaveProperty('package');
    expectContract('Task', body.items[0]);
  });

  it.each(['/v1/applications', '/v1/tasks'])('echoes page_size for GET %s', async (routePath) => {
    const response = await fetch(`${baseUrl}${routePath}?page_size=2`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { page: { page_size: number } };
    expect(body.page.page_size).toBe(2);
  });

  it.each(['/v1/applications', '/v1/tasks'])(
    'returns contract 400 when page_size exceeds the maximum for GET %s',
    async (routePath) => {
      const response = await fetch(`${baseUrl}${routePath}?page_size=101`, {
        headers: { authorization: `Bearer ${signToken(USER_A)}` },
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expectContract('ErrorEnvelope', body);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    },
  );

  it('filters applications by status', async () => {
    await store.saveApplication(
      USER_A,
      applicationFixture('50000000-0000-4000-8000-000000000003', USER_A, 'draft'),
    );
    await store.saveApplication(
      USER_A,
      applicationFixture('50000000-0000-4000-8000-000000000004', USER_A, 'submitted'),
    );

    const response = await fetch(`${baseUrl}/v1/applications?status=submitted`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Application[] };
    expect(body.items).toHaveLength(1);
    expect(body.items.every((item) => item.status === 'submitted')).toBe(true);
  });

  it('rejects an invalid application status with the common error envelope', async () => {
    const response = await fetch(`${baseUrl}/v1/applications?status=unknown`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('uses the last item id as an opaque cursor', async () => {
    const firstId = '50000000-0000-4000-8000-000000000005';
    const secondId = '50000000-0000-4000-8000-000000000006';
    await store.saveApplication(USER_A, applicationFixture(firstId, USER_A));
    await store.saveApplication(USER_A, applicationFixture(secondId, USER_A));

    const first = await fetch(`${baseUrl}/v1/applications?page_size=1`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    const firstBody = (await first.json()) as {
      items: Application[];
      page: { next_cursor: string };
    };
    expect(firstBody.page.next_cursor).toBe(firstBody.items[0]?.id);
    const second = await fetch(
      `${baseUrl}/v1/applications?cursor=${encodeURIComponent(firstBody.page.next_cursor)}`,
      { headers: { authorization: `Bearer ${signToken(USER_A)}` } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { items: Application[] };
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
  });
});
