import { Module } from '@nestjs/common';
import { Pool } from 'pg';

import { PROFILE_STORE } from './profile-store.interface';
import type { ProfileStore } from './profile-store.interface';
import { ProfileService } from './profile.service';
import { PostgresProfileStore } from './profile.postgres-store';

function createProfileStore(): ProfileStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. ProfileModule requires PostgreSQL as the single source of truth ' +
        'and will not silently fall back to an in-memory store. Set DATABASE_URL to start this module.',
    );
  }
  const pool = new Pool({ connectionString });
  return new PostgresProfileStore(pool);
}

@Module({
  providers: [{ provide: PROFILE_STORE, useFactory: createProfileStore }, ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
