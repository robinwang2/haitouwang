import { createHash } from 'node:crypto';

import { parseJobDocument } from './job.parsers';
import type { ParsedJob } from './job.parsers';
import type {
  DescriptionStatus,
  Job,
  JobImportDocument,
  JobImportOptions,
  JobSource,
  JobSourceRef,
} from './job.types';

const SOURCE_PRIORITY: Readonly<Record<JobSource, number>> = {
  company_careers: 0,
  greenhouse: 1,
  lever: 2,
  manual_url: 3,
};

const DESCRIPTION_PRIORITY: Readonly<Record<DescriptionStatus, number>> = {
  complete: 0,
  partial: 1,
  missing: 2,
};

/**
 * Parses, normalizes and deduplicates one deterministic import batch.
 *
 * Cross-source records are merged when company, title and location normalize
 * to the same fingerprint. Same-source postings only merge on canonical URL or
 * native source reference, preventing distinct requisitions with a shared
 * title from collapsing.
 */
export function runJobImportPipeline(
  documents: readonly JobImportDocument[],
  options: JobImportOptions,
): Job[] {
  const parsed = documents.map((document) => parseJobDocument(document, options.now));
  const groups = groupDuplicates(parsed);
  return groups.map(mergeGroup).sort(compareJobs);
}

function groupDuplicates(jobs: ParsedJob[]): ParsedJob[][] {
  const parents = jobs.map((_, index) => index);

  const root = (index: number): number => {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]];
      current = parents[current];
    }
    return current;
  };

  const union = (left: number, right: number): void => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) {
      parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    }
  };

  for (let left = 0; left < jobs.length; left += 1) {
    for (let right = left + 1; right < jobs.length; right += 1) {
      if (isDuplicate(jobs[left], jobs[right])) {
        union(left, right);
      }
    }
  }

  const groups = new Map<number, ParsedJob[]>();
  jobs.forEach((job, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), job]);
  });
  return [...groups.values()];
}

function isDuplicate(left: ParsedJob, right: ParsedJob): boolean {
  if (left.canonicalUrl === right.canonicalUrl) {
    return true;
  }
  if (left.source === right.source && left.sourceRef.reference === right.sourceRef.reference) {
    return true;
  }
  return left.source !== right.source && fingerprint(left) === fingerprint(right);
}

function mergeGroup(group: ParsedJob[]): Job {
  const candidates = [...group].sort(compareCandidates);
  const primary = candidates[0];
  const sourceRefs = uniqueSourceRefs(candidates.map((candidate) => candidate.sourceRef));
  const capturedTimes = candidates.map((candidate) => candidate.capturedAt).sort();
  const descriptionStatus = candidates
    .map((candidate) => candidate.descriptionStatus)
    .sort((left, right) => DESCRIPTION_PRIORITY[left] - DESCRIPTION_PRIORITY[right])[0];
  const salaryCandidate = candidates.find((candidate) => candidate.salary !== undefined);
  const allExpired = candidates.every((candidate) => candidate.expired);
  const spansSources = new Set(candidates.map((candidate) => candidate.source)).size > 1;
  const identitySeed = spansSources
    ? fingerprint(primary)
    : `${primary.source}:${primary.canonicalUrl}:${primary.sourceRef.reference}`;

  return {
    id: deterministicUuid(`job:${identitySeed}`),
    canonical_url: primary.canonicalUrl,
    source: primary.source,
    source_refs: sourceRefs,
    title: primary.title,
    company: primary.company,
    location: primary.location,
    employment_type: primary.employmentType,
    ...(salaryCandidate?.salary === undefined ? {} : { salary: salaryCandidate.salary }),
    description_status: descriptionStatus,
    risk: primary.risk,
    status: allExpired ? 'expired' : primary.risk.requires_manual_review ? 'risk_review' : 'active',
    version: 1,
    created_at: capturedTimes[0],
    updated_at: capturedTimes.at(-1) ?? capturedTimes[0],
  };
}

function compareCandidates(left: ParsedJob, right: ParsedJob): number {
  return (
    SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
    DESCRIPTION_PRIORITY[left.descriptionStatus] - DESCRIPTION_PRIORITY[right.descriptionStatus] ||
    left.canonicalUrl.localeCompare(right.canonicalUrl) ||
    left.sourceRef.reference.localeCompare(right.sourceRef.reference)
  );
}

function compareJobs(left: Job, right: Job): number {
  return (
    left.company.localeCompare(right.company) ||
    left.title.localeCompare(right.title) ||
    left.location.localeCompare(right.location) ||
    left.id.localeCompare(right.id)
  );
}

function uniqueSourceRefs(refs: JobSourceRef[]): JobSourceRef[] {
  const unique = new Map<string, JobSourceRef>();
  for (const ref of refs) {
    const key = `${ref.type}\0${ref.reference}`;
    const current = unique.get(key);
    if (current === undefined || ref.captured_at > current.captured_at) {
      unique.set(key, ref);
    }
  }
  return [...unique.values()].sort(
    (left, right) =>
      SOURCE_PRIORITY[left.type] - SOURCE_PRIORITY[right.type] ||
      left.reference.localeCompare(right.reference),
  );
}

function fingerprint(job: ParsedJob): string {
  return [
    normalizeCompany(job.company),
    normalizeIdentityPart(job.title),
    normalizeIdentityPart(job.location),
  ].join('|');
}

function normalizeCompany(value: string): string {
  return normalizeIdentityPart(value).replace(
    /(?: incorporated| corporation| company| limited| inc| corp| llc| ltd)$/u,
    '',
  );
}

function normalizeIdentityPart(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replaceAll('&', ' and ')
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
