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
  InMemoryReportingStore,
  type Notification,
  REPORTING_STORE,
} from '../../src/modules/reporting';

const TEST_AUDIENCE = 'haitouwang-api-test';
const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';

const domainSchema = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../contracts/schemas/domain.schema.json'), 'utf8'),
) as { $id: string };
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(domainSchema);

function expectContract(name: 'Notification' | 'ErrorEnvelope', value: unknown): void {
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

function notificationFixture(id: string, userId: string): Notification {
  return {
    id,
    user_id: userId,
    type: 'review_required',
    status: 'pending',
    dedupe_key: `review:${id}`,
    channel: 'in_app',
    source_ref: { type: 'application', id: '50000000-0000-4000-8000-000000000001' },
    created_at: '2026-08-29T00:00:00.000Z',
  };
}

describe('ReportingController HTTP read surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: InMemoryReportingStore;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'haitouwang-reporting-http-'));
    process.env.MATERIALS_DATABASE_PATH = path.join(temporaryDirectory, 'materials.sqlite');
    process.env.AUTH_JWT_SECRET = testSecret();
    process.env.AUTH_JWT_AUDIENCE = TEST_AUDIENCE;

    store = new InMemoryReportingStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REPORTING_STORE)
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
    const response = await fetch(`${baseUrl}/v1/notifications`);
    expect(response.status).toBe(401);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('returns contract notifications for only the authenticated tenant', async () => {
    const ownId = '70000000-0000-4000-8000-000000000001';
    const otherId = '70000000-0000-4000-8000-000000000002';
    await store.saveNotification(USER_A, notificationFixture(ownId, USER_A));
    await store.saveNotification(USER_B, notificationFixture(otherId, USER_B));

    const response = await fetch(`${baseUrl}/v1/notifications`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Notification[]; page: unknown };
    expect(Object.keys(body).sort()).toEqual(['items', 'page']);
    expect(body.items.map((item) => item.id)).toEqual([ownId]);
    expect(body.items.every((item) => item.user_id === USER_A)).toBe(true);
    expectContract('Notification', body.items[0]);
  });

  it('echoes page_size and advances by cursor', async () => {
    const firstId = '70000000-0000-4000-8000-000000000003';
    const secondId = '70000000-0000-4000-8000-000000000004';
    await store.saveNotification(USER_A, notificationFixture(firstId, USER_A));
    await store.saveNotification(USER_A, notificationFixture(secondId, USER_A));

    const first = await fetch(`${baseUrl}/v1/notifications?page_size=1`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Notification[];
      page: { page_size: number; next_cursor: string };
    };
    expect(firstBody.page.page_size).toBe(1);
    expect(firstBody.page.next_cursor).toBe(firstBody.items[0]?.id);

    const second = await fetch(
      `${baseUrl}/v1/notifications?cursor=${encodeURIComponent(firstBody.page.next_cursor)}`,
      { headers: { authorization: `Bearer ${signToken(USER_A)}` } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { items: Notification[] };
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
  });

  it('returns contract 400 when page_size exceeds the maximum', async () => {
    const response = await fetch(`${baseUrl}/v1/notifications?page_size=101`, {
      headers: { authorization: `Bearer ${signToken(USER_A)}` },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expectContract('ErrorEnvelope', body);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});
