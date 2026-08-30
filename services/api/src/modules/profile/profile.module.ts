import { Module } from '@nestjs/common';

import { AuthService } from '../../auth.service';
import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { PROFILE_STORE } from './profile-store.interface';
import type { ProfileStore } from './profile-store.interface';
import { ProfileController } from './profile.controller';
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
  controllers: [ProfileController],
  providers: [
    { provide: PROFILE_STORE, useFactory: createProfileStore },
    ProfileService,
    // BearerAuthGuard (used by ProfileController) depends on AuthService. AppModule also
    // provides AuthService, but Nest module DI is not ambient across sibling imports, so
    // this module needs its own instance; AuthService is stateless (reads env at
    // construction only), so a second instance is safe.
    AuthService,
  ],
  exports: [ProfileService],
})
export class ProfileModule {}
