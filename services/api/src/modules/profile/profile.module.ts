import { Module } from '@nestjs/common';

import { PROFILE_STORE } from './profile-store.interface';
import { ProfileService } from './profile.service';
import { InMemoryProfileStore } from './profile.store';

@Module({
  providers: [{ provide: PROFILE_STORE, useClass: InMemoryProfileStore }, ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
