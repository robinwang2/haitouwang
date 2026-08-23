import { Logger, Module } from '@nestjs/common';
import { Pool } from 'pg';

import { PROFILE_STORE } from './profile-store.interface';
import type { ProfileStore } from './profile-store.interface';
import { ProfileService } from './profile.service';
import { PostgresProfileStore } from './profile.postgres-store';
import { InMemoryProfileStore } from './profile.store';

const logger = new Logger('ProfileModule');

function createProfileStore(): ProfileStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.warn('DATABASE_URL is not set; falling back to InMemoryProfileStore (data is not persisted).');
    return new InMemoryProfileStore();
  }
  const pool = new Pool({ connectionString });
  return new PostgresProfileStore(pool);
}

@Module({
  providers: [{ provide: PROFILE_STORE, useFactory: createProfileStore }, ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
