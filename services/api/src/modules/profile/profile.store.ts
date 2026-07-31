import { Injectable } from '@nestjs/common';

import type { AuditEvent, Fact, FileMetadata, Goal, VersionRecord } from './profile.types';

interface IdempotencyRecord {
  request_hash: string;
  response: unknown;
  audit_event_id: string;
}

@Injectable()
export class InMemoryProfileStore {
  readonly goals = new Map<string, Goal>();
  readonly facts = new Map<string, Fact>();
  readonly files = new Map<string, FileMetadata>();
  readonly goalVersions = new Map<string, VersionRecord<Goal>[]>();
  readonly factVersions = new Map<string, VersionRecord<Fact>[]>();
  readonly fileVersions = new Map<string, VersionRecord<FileMetadata>[]>();
  readonly auditEvents: AuditEvent[] = [];
  readonly idempotency = new Map<string, IdempotencyRecord>();
}
