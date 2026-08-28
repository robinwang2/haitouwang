import { Module } from '@nestjs/common';

import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { PROFILE_STORE } from './profile-store.interface';
import type { ProfileStore } from './profile-store.interface';
import { ProfileService } from './profile.service';
import { PostgresProfileStore } from './profile.postgres-store';

function createProfileStore(): ProfileStore {
  return createLazyPostgresStore<ProfileStore>(
    'ProfileModule',
    {
      withTransaction: true,
      getGoal: true,
      listGoals: true,
      saveGoal: true,
      deleteGoal: true,
      getFact: true,
      listFacts: true,
      saveFact: true,
      deleteFact: true,
      getFile: true,
      listFiles: true,
      saveFile: true,
      deleteFile: true,
      listGoalVersions: true,
      appendGoalVersion: true,
      deleteGoalVersions: true,
      listFactVersions: true,
      appendFactVersion: true,
      replaceFactVersions: true,
      deleteFactVersions: true,
      listFileVersions: true,
      appendFileVersion: true,
      deleteFileVersions: true,
      listAuditEvents: true,
      appendAuditEvent: true,
      getIdempotency: true,
      saveIdempotency: true,
      deleteIdempotencyForResource: true,
      deleteIdempotencyForUser: true,
      deleteUserData: true,
    },
    (pool) => new PostgresProfileStore(pool),
  );
}

@Module({
  providers: [{ provide: PROFILE_STORE, useFactory: createProfileStore }, ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
