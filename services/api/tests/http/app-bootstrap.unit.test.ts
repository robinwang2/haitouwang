import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NestFactory, type INestApplication } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { JobService } from '../../src/modules/jobs';

function testAuthSecret(): string {
  return `test-only-auth-${'x'.repeat(32)}`;
}

describe('AppModule bootstrap without DATABASE_URL', () => {
  let originalDatabaseUrl: string | undefined;
  let originalAuthSecret: string | undefined;
  let originalAuthAudience: string | undefined;
  let temporaryDirectory: string;
  let app: INestApplication | undefined;

  beforeEach(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    // AuthService (also wired into AppModule) requires a real secret to
    // construct at all; set one so the only thing under test here is
    // JobsModule's DATABASE_URL handling.
    originalAuthSecret = process.env.AUTH_JWT_SECRET;
    originalAuthAudience = process.env.AUTH_JWT_AUDIENCE;
    process.env.AUTH_JWT_SECRET = testAuthSecret();
    process.env.AUTH_JWT_AUDIENCE = 'haitouwang-api-test';

    // MaterialsModule's repository opens a sqlite file eagerly at
    // construction time. Point it at a throwaway path so this suite doesn't
    // write into the repo's data/ directory as a side effect.
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'app-bootstrap-'));
    process.env.MATERIALS_DATABASE_PATH = path.join(temporaryDirectory, 'materials.sqlite');
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalAuthSecret === undefined) {
      delete process.env.AUTH_JWT_SECRET;
    } else {
      process.env.AUTH_JWT_SECRET = originalAuthSecret;
    }
    if (originalAuthAudience === undefined) {
      delete process.env.AUTH_JWT_AUDIENCE;
    } else {
      process.env.AUTH_JWT_AUDIENCE = originalAuthAudience;
    }
    delete process.env.MATERIALS_DATABASE_PATH;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates the application without throwing even though DATABASE_URL is unset', async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    expect(app).toBeDefined();
  });

  it('defers the missing-DATABASE_URL failure to the first jobs-store access', async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    const jobService = app.get(JobService);

    await expect(jobService.listJobs()).rejects.toThrow(/DATABASE_URL/);
  });
});
