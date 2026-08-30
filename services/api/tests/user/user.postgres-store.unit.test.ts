import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresUserStore } from '../../src/modules/user';
import type { User } from '../../src/modules/user';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.info(
    '[user.postgres-store] DATABASE_URL is not set - skipping PostgresUserStore integration ' +
      'tests. This sandbox has no Docker/Postgres available (see docs/qa/mvp-report.md); set ' +
      'DATABASE_URL to a disposable Postgres instance to exercise the real SQL implementation.',
  );
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/db/migrations/user',
);

async function migrationSql(suffix: '.up.sql' | '.down.sql'): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(suffix)).sort();
  return Promise.all(files.map((file) => readFile(path.join(MIGRATIONS_DIR, file), 'utf8')));
}

async function resetSchema(pool: Pool): Promise<void> {
  const downSqls = (await migrationSql('.down.sql')).reverse();
  for (const sql of downSqls) {
    await pool.query(sql);
  }
}

function userFixture(overrides: Partial<User> = {}): User {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
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

async function insertUser(pool: Pool, user: User): Promise<void> {
  await pool.query(
    `INSERT INTO user_accounts (
       id, email, display_name, locale, time_zone, status, version, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      user.id,
      user.email,
      user.display_name,
      user.locale,
      user.time_zone,
      user.status,
      user.version,
      user.created_at,
      user.updated_at,
    ],
  );
}

describe.skipIf(!DATABASE_URL)('PostgresUserStore integration', () => {
  let pool: Pool;
  let store: PostgresUserStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await resetSchema(pool);
    const upSqls = await migrationSql('.up.sql');
    for (const sql of upSqls) {
      await pool.query(sql);
    }
    store = new PostgresUserStore(pool);
  });

  afterAll(async () => {
    await resetSchema(pool);
    await pool.end();
  });

  it('returns a user row mapped to the User shape', async () => {
    const user = userFixture();
    await insertUser(pool, user);

    expect(await store.getUser(user.id)).toEqual(user);
  });

  it('returns undefined for an id with no matching row', async () => {
    expect(await store.getUser(randomUUID())).toBeUndefined();
  });

  it('enforces the email uniqueness constraint at the SQL layer', async () => {
    const email = `dup-${randomUUID()}@example.com`;
    await insertUser(pool, userFixture({ email }));

    await expect(insertUser(pool, userFixture({ email }))).rejects.toThrow();
  });
});
