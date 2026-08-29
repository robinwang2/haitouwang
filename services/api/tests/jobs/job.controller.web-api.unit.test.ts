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
import { InMemoryJobStore, JOBS_STORE } from '../../src/modules/jobs';
import type { Job, JobStatus } from '../../src/modules/jobs';

const TEST_AUDIENCE = 'haitouwang-api-test';

const domainSchema = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../contracts/schemas/domain.schema.json'), 'utf8'),
) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(domainSchema);

function expectContract(name: 'Job' | 'ErrorEnvelope', value: unknown): void {
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

function jobFixture(id: string, overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id,
    canonical_url: `https://careers.example.test/jobs/${id}`,
    source: 'manual_url',
    source_refs: [
      {
        type: 'manual_url',
        reference: `https://careers.example.test/jobs/${id}`,
        captured_at: now,
        content_hash: 'a'.repeat(64),
      },
    ],
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'low', reasons: [], requires_manual_review: false },
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('JobController HTTP surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryJobStore;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'haitouwang-jobs-'));
    process.env.MATERIALS_DATABASE_PATH = path.join(temporaryDirectory, 'materials.sqlite');
    process.env.AUTH_JWT_SECRET = testSecret();
    process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;

    store = new InMemoryJobStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOBS_STORE)
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
    const response = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED', retryable: false } });
  });

  it('returns 200 with items and page for an authenticated caller', async () => {
    const jobId = randomUUID();
    await store.saveJob(jobFixture(jobId));

    const response = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { authorization: `Bearer ${signToken(randomUUID())}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Job[]; page: unknown };
    expect(Object.keys(body).sort()).toEqual(['items', 'page']);
    expect(body.items).toHaveLength(1);
    expectContract('Job', body.items[0]);
    expect(body.items[0]!.id).toBe(jobId);
  });

  it('echoes the requested page_size in page.page_size', async () => {
    for (let i = 0; i < 3; i += 1) {
      await store.saveJob(jobFixture(randomUUID()));
    }

    const response = await fetch(`${baseUrl}/v1/jobs?page_size=2`, {
      headers: { authorization: `Bearer ${signToken(randomUUID())}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Job[]; page: { page_size: number } };
    expect(body.page.page_size).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it('returns a contract 4xx, not a 500, when page_size exceeds the maximum', async () => {
    const response = await fetch(`${baseUrl}/v1/jobs?page_size=101`, {
      headers: { authorization: `Bearer ${signToken(randomUUID())}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('filters by status so every returned record matches the requested status', async () => {
    const activeId = randomUUID();
    const expiredId = randomUUID();
    await store.saveJob(jobFixture(activeId, { status: 'active' as JobStatus }));
    await store.saveJob(jobFixture(expiredId, { status: 'expired' as JobStatus }));

    const response = await fetch(`${baseUrl}/v1/jobs?status=expired`, {
      headers: { authorization: `Bearer ${signToken(randomUUID())}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Job[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((job) => job.status === 'expired')).toBe(true);
  });

  it('does not filter jobs by user_id - any authenticated tenant sees the same global list', async () => {
    const jobId = randomUUID();
    await store.saveJob(jobFixture(jobId));

    const first = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { authorization: `Bearer ${signToken(randomUUID())}` },
    });
    const second = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { authorization: `Bearer ${signToken(randomUUID())}` },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { items: Job[] };
    const secondBody = (await second.json()) as { items: Job[] };
    expect(firstBody.items.map((job) => job.id)).toEqual(secondBody.items.map((job) => job.id));
  });
});
