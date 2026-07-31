import { Module } from '@nestjs/common';

import { ProfileService } from './profile.service';
import { InMemoryProfileStore } from './profile.store';

@Module({
  providers: [InMemoryProfileStore, ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
