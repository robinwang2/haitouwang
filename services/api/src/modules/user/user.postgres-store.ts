import type { Pool, QueryResultRow } from 'pg';

import type { UserStore } from './user-store.interface';
import type { User, UserStatus } from './user.types';

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  display_name: string;
  locale: string;
  time_zone: string;
  status: UserStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    locale: row.locale,
    time_zone: row.time_zone,
    status: row.status,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Postgres-backed implementation of UserStore. Looks up a single row by id. */
export class PostgresUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async getUser(userId: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, email, display_name, locale, time_zone, status, version, created_at, updated_at FROM user_accounts WHERE id = $1',
      [userId],
    );
    return rows[0] ? mapUser(rows[0]) : undefined;
  }
}
