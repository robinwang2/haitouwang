import { createHash } from 'node:crypto';

import type {
  DescriptionStatus,
  EmploymentType,
  JobImportDocument,
  JobRisk,
  JobSource,
  JobSourceRef,
  MoneyRange,
} from './job.types';
import { JobImportError } from './job.types';

export interface ParsedJob {
  source: JobSource;
  sourceRef: JobSourceRef;
  canonicalUrl: string;
  title: string;
  company: string;
  location: string;
  employmentType: EmploymentType;
  salary?: MoneyRange;
  descriptionStatus: DescriptionStatus;
  risk: JobRisk;
  expired: boolean;
  capturedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const HIGH_RISK_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  [
    'payment_requested',
    /\b(?:pay|payment|fee|deposit)\b.{0,40}\b(?:apply|application|training)\b/i,
  ],
  ['gift_card_or_crypto_requested', /\b(?:gift\s*cards?|bitcoin|crypto(?:currency)?)\b/i],
  ['personal_messaging_contact', /\b(?:telegram|whats\s*app|signal)\b/i],
];

const SOURCE_HOST_PATTERNS: Partial<Record<JobSource, RegExp>> = {
  greenhouse: /(?:^|\.)greenhouse\.io$/i,
  lever: /(?:^|\.)lever\.co$/i,
};

export function parseJobDocument(document: JobImportDocument, now: string): ParsedJob {
  const capturedAt = parseTimestamp(document.fetched_at, document.source, 'fetched_at');
  const nowDate = parseTimestamp(now, document.source, 'now');
  const documentUrl = canonicalizeJobUrl(document.url, document.source);
  const payload = extractPayload(document);
  const common =
    document.source === 'greenhouse'
      ? parseGreenhouse(payload, document, documentUrl)
      : document.source === 'lever'
        ? parseLever(payload, document, documentUrl)
        : parseStructuredPage(payload, document, documentUrl);

  const canonicalUrl = canonicalizeJobUrl(common.url ?? documentUrl, document.source);
  const title = requireText(common.title, document.source, 'title');
  const company = requireText(
    common.company ?? document.company ?? companyFromUrl(canonicalUrl, document.source),
    document.source,
    'company',
  );
  const location = cleanText(common.location) || 'Unknown';
  const description = cleanDescription(common.description);
  const descriptionStatus = classifyDescription(description);
  const employmentType = normalizeEmploymentType(common.employmentType);
  const risk = assessRisk({
    source: document.source,
    url: canonicalUrl,
    description,
    descriptionStatus,
    locationMissing: location === 'Unknown',
  });
  const expired =
    common.closed === true ||
    (common.validThrough !== undefined &&
      parseTimestamp(common.validThrough, document.source, 'validThrough').getTime() <
        nowDate.getTime());
  const sourceReference = cleanText(common.sourceReference) || canonicalUrl;

  return {
    source: document.source,
    sourceRef: {
      type: document.source,
      reference: sourceReference.slice(0, 512),
      captured_at: capturedAt.toISOString(),
      content_hash: hashPayload(document.payload),
    },
    canonicalUrl,
    title,
    company,
    location,
    employmentType,
    ...(common.salary === undefined ? {} : { salary: common.salary }),
    descriptionStatus,
    risk,
    expired,
    capturedAt: capturedAt.toISOString(),
  };
}

interface CommonFields {
  url?: string;
  sourceReference?: string;
  title?: string;
  company?: string;
  location?: string;
  employmentType?: unknown;
  description?: string;
  salary?: MoneyRange;
  validThrough?: string;
  closed?: boolean;
}

function parseGreenhouse(
  payload: UnknownRecord,
  document: JobImportDocument,
  documentUrl: string,
): CommonFields {
  const selected = selectPosting(payload, documentUrl, ['absolute_url', 'url'], document.source);
  const location = asRecord(selected.location);
  const company = asRecord(selected.company);
  const status = cleanText(selected.status).toLowerCase();

  return {
    url: optionalText(selected.absolute_url) ?? optionalText(selected.url),
    sourceReference:
      optionalText(selected.id) ?? optionalText(selected.internal_job_id) ?? documentUrl,
    title: optionalText(selected.title),
    company: optionalText(selected.company_name) ?? optionalText(company.name) ?? document.company,
    location: optionalText(location.name) ?? optionalText(selected.location_name),
    employmentType:
      selected.employment_type ??
      selected.employmentType ??
      findMetadataValue(selected, 'employment'),
    description:
      optionalText(selected.content) ??
      optionalText(selected.description) ??
      optionalText(selected.description_html),
    salary: parseSalary(selected.salary),
    validThrough:
      optionalText(selected.valid_through) ??
      optionalText(selected.validThrough) ??
      optionalText(selected.expires_at),
    closed: ['closed', 'inactive', 'removed'].includes(status) || selected.active === false,
  };
}

function parseLever(
  payload: UnknownRecord,
  document: JobImportDocument,
  documentUrl: string,
): CommonFields {
  const selected = selectPosting(
    payload,
    documentUrl,
    ['hostedUrl', 'applyUrl', 'url'],
    document.source,
  );
  const categories = asRecord(selected.categories);
  const status = cleanText(selected.state ?? selected.status).toLowerCase();
  const descriptionParts = [
    optionalText(selected.descriptionPlain),
    optionalText(selected.description),
    ...asArray(selected.lists).flatMap((entry) => {
      const list = asRecord(entry);
      return [optionalText(list.text), optionalText(list.content)].filter(
        (value): value is string => value !== undefined,
      );
    }),
  ].filter((value): value is string => value !== undefined);

  return {
    url:
      optionalText(selected.hostedUrl) ??
      optionalText(selected.applyUrl) ??
      optionalText(selected.url),
    sourceReference: optionalText(selected.id) ?? documentUrl,
    title: optionalText(selected.text) ?? optionalText(selected.title),
    company: optionalText(selected.company) ?? document.company,
    location: optionalText(categories.location) ?? optionalText(selected.location),
    employmentType: categories.commitment ?? selected.commitment ?? selected.employment_type,
    description: descriptionParts.join(' '),
    salary: parseSalary(selected.salaryRange ?? selected.salary),
    validThrough:
      optionalText(selected.validThrough) ??
      optionalText(selected.expiresAt) ??
      optionalText(selected.closedAt),
    closed: ['closed', 'inactive', 'archived'].includes(status),
  };
}

function parseStructuredPage(
  payload: UnknownRecord,
  document: JobImportDocument,
  documentUrl: string,
): CommonFields {
  const posting = findJobPosting(payload);
  const organization = asRecord(posting.hiringOrganization);
  const status = cleanText(posting.status).toLowerCase();
  const url = optionalText(posting.url) ?? documentUrl;

  return {
    url,
    sourceReference:
      optionalText(posting.identifier) ?? optionalText(asRecord(posting.identifier).value) ?? url,
    title: optionalText(posting.title) ?? optionalText(posting.name),
    company: optionalText(organization.name) ?? optionalText(posting.company) ?? document.company,
    location: structuredLocation(posting),
    employmentType: posting.employmentType,
    description: optionalText(posting.description),
    salary: parseStructuredSalary(posting.baseSalary) ?? parseSalary(posting.salary),
    validThrough:
      optionalText(posting.validThrough) ??
      optionalText(posting.expires_at) ??
      optionalText(posting.expiresAt),
    closed:
      ['closed', 'inactive', 'removed', 'expired'].includes(status) || posting.active === false,
  };
}

function extractPayload(document: JobImportDocument): UnknownRecord {
  if (typeof document.payload === 'string') {
    const structured = extractJsonLd(document.payload, document.source);
    if (structured !== undefined) {
      return structured;
    }

    return extractHtmlMetadata(document.payload);
  }

  if (!isRecord(document.payload)) {
    throw new JobImportError('Job payload must be an object or HTML string', document.source);
  }

  return document.payload;
}

function extractJsonLd(html: string, source: JobSource): UnknownRecord | undefined {
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const match of scripts) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      const posting = findJobPostingInUnknown(parsed);
      if (posting !== undefined) {
        return posting;
      }
    } catch {
      throw new JobImportError('Invalid JSON-LD job payload', source, 'payload');
    }
  }

  return undefined;
}

function extractHtmlMetadata(html: string): UnknownRecord {
  const metadata: UnknownRecord = {};
  for (const match of html.matchAll(/<meta\b([^>]+)>/gi)) {
    const attributes = match[1];
    const name =
      matchAttribute(attributes, 'property')?.toLowerCase() ??
      matchAttribute(attributes, 'name')?.toLowerCase();
    const content = matchAttribute(attributes, 'content');
    if (name !== undefined && content !== undefined) {
      metadata[name] = content;
    }
  }

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    title: metadata['og:title'] ?? title,
    company: metadata['og:site_name'],
    description: metadata['og:description'] ?? metadata.description,
  };
}

function findJobPosting(payload: UnknownRecord): UnknownRecord {
  return findJobPostingInUnknown(payload) ?? payload;
}

function findJobPostingInUnknown(value: unknown): UnknownRecord | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findJobPostingInUnknown(item);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const type = value['@type'];
  if (
    type === 'JobPosting' ||
    (Array.isArray(type) && type.some((entry) => entry === 'JobPosting'))
  ) {
    return value;
  }

  const graph = value['@graph'];
  return graph === undefined ? undefined : findJobPostingInUnknown(graph);
}

function selectPosting(
  payload: UnknownRecord,
  documentUrl: string,
  urlFields: string[],
  source: JobSource,
): UnknownRecord {
  const candidates = asArray(payload.jobs ?? payload.postings);
  if (candidates.length === 0) {
    return payload;
  }

  const normalizedDocumentUrl = canonicalizeUrlUnchecked(documentUrl);
  const matching = candidates.find((candidate) => {
    const record = asRecord(candidate);
    return urlFields.some((field) => {
      const value = optionalText(record[field]);
      return value !== undefined && canonicalizeUrlUnchecked(value) === normalizedDocumentUrl;
    });
  });

  if (matching !== undefined) {
    return asRecord(matching);
  }
  if (candidates.length === 1) {
    return asRecord(candidates[0]);
  }

  throw new JobImportError(
    'Payload contains multiple jobs and none matches the requested URL',
    source,
  );
}

function assessRisk(input: {
  source: JobSource;
  url: string;
  description: string;
  descriptionStatus: DescriptionStatus;
  locationMissing: boolean;
}): JobRisk {
  const highReasons: string[] = [];
  const mediumReasons: string[] = [];
  const url = new URL(input.url);

  if (url.protocol !== 'https:') {
    highReasons.push('insecure_posting_url');
  }

  const expectedHost = SOURCE_HOST_PATTERNS[input.source];
  if (expectedHost !== undefined && !expectedHost.test(url.hostname)) {
    mediumReasons.push('source_host_unrecognized');
  }

  for (const [reason, pattern] of HIGH_RISK_PATTERNS) {
    if (pattern.test(input.description)) {
      highReasons.push(reason);
    }
  }

  if (input.descriptionStatus === 'missing') {
    highReasons.push('description_missing');
  } else if (input.descriptionStatus === 'partial') {
    mediumReasons.push('description_partial');
  }
  if (input.locationMissing) {
    mediumReasons.push('location_missing');
  }

  const reasons = [...new Set([...highReasons, ...mediumReasons])].sort();
  if (highReasons.length > 0) {
    return { level: 'high', reasons, requires_manual_review: true };
  }
  if (mediumReasons.length > 0) {
    return { level: 'medium', reasons, requires_manual_review: true };
  }
  return { level: 'low', reasons: [], requires_manual_review: false };
}

function parseStructuredSalary(value: unknown): MoneyRange | undefined {
  const salary = asRecord(value);
  const amount = asRecord(salary.value);
  const currency = cleanText(salary.currency ?? amount.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return undefined;
  }

  const minimum = optionalNumber(amount.minValue ?? amount.minimum);
  const maximum = optionalNumber(amount.maxValue ?? amount.maximum);
  const exact = optionalNumber(amount.value);
  const period = normalizeSalaryPeriod(amount.unitText ?? amount.period);
  return compactSalary({
    currency,
    minimum: minimum ?? exact,
    maximum: maximum ?? exact,
    period,
  });
}

function parseSalary(value: unknown): MoneyRange | undefined {
  const salary = asRecord(value);
  const currency = cleanText(salary.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return undefined;
  }

  return compactSalary({
    currency,
    minimum: optionalNumber(salary.minimum ?? salary.min),
    maximum: optionalNumber(salary.maximum ?? salary.max),
    period: normalizeSalaryPeriod(salary.period ?? salary.interval),
  });
}

function compactSalary(input: {
  currency: string;
  minimum?: number;
  maximum?: number;
  period?: 'hour' | 'month' | 'year';
}): MoneyRange {
  return {
    currency: input.currency,
    ...(input.minimum === undefined ? {} : { minimum: input.minimum }),
    ...(input.maximum === undefined ? {} : { maximum: input.maximum }),
    ...(input.period === undefined ? {} : { period: input.period }),
  };
}

function normalizeSalaryPeriod(value: unknown): 'hour' | 'month' | 'year' | undefined {
  const normalized = cleanText(value).toLowerCase();
  if (normalized.includes('hour')) {
    return 'hour';
  }
  if (normalized.includes('month')) {
    return 'month';
  }
  if (normalized.includes('year') || normalized.includes('annual')) {
    return 'year';
  }
  return undefined;
}

function normalizeEmploymentType(value: unknown): EmploymentType {
  const values = (Array.isArray(value) ? value : [value])
    .map((item) =>
      cleanText(item)
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '_'),
    )
    .filter(Boolean);

  for (const normalized of values) {
    if (normalized.includes('full_time') || normalized === 'fulltime') {
      return 'full_time';
    }
    if (normalized.includes('part_time') || normalized === 'parttime') {
      return 'part_time';
    }
    if (normalized.includes('intern')) {
      return 'internship';
    }
    if (
      normalized.includes('contract') ||
      normalized.includes('freelance') ||
      normalized.includes('consultant')
    ) {
      return 'contract';
    }
    if (normalized.includes('temporary') || normalized === 'temp') {
      return 'temporary';
    }
    if (normalized === 'other') {
      return 'other';
    }
  }
  return 'unknown';
}

function classifyDescription(description: string): DescriptionStatus {
  if (description.length === 0) {
    return 'missing';
  }
  return description.length < 160 ? 'partial' : 'complete';
}

function findMetadataValue(record: UnknownRecord, label: string): unknown {
  const metadata = asArray(record.metadata);
  for (const entry of metadata) {
    const item = asRecord(entry);
    if (cleanText(item.name).toLowerCase().includes(label)) {
      return item.value;
    }
  }
  return undefined;
}

function formatAddress(address: UnknownRecord): string | undefined {
  const parts = [
    optionalText(address.addressLocality),
    optionalText(address.addressRegion),
    optionalText(address.addressCountry),
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? undefined : [...new Set(parts)].join(', ');
}

function structuredLocation(posting: UnknownRecord): string | undefined {
  if (cleanText(posting.jobLocationType).toUpperCase() === 'TELECOMMUTE') {
    return 'Remote';
  }

  const jobLocations = Array.isArray(posting.jobLocation)
    ? posting.jobLocation
    : [posting.jobLocation];
  for (const locationValue of jobLocations) {
    const location = asRecord(locationValue);
    const formatted = formatAddress(asRecord(location.address)) ?? optionalText(location.name);
    if (formatted !== undefined) {
      return formatted;
    }
  }

  const applicantLocations = Array.isArray(posting.applicantLocationRequirements)
    ? posting.applicantLocationRequirements
    : [posting.applicantLocationRequirements];
  for (const locationValue of applicantLocations) {
    const name = optionalText(asRecord(locationValue).name) ?? optionalText(locationValue);
    if (name !== undefined) {
      return name;
    }
  }
  return optionalText(posting.jobLocation);
}

function companyFromUrl(value: string, source: JobSource): string {
  const url = new URL(value);
  if (source === 'greenhouse' || source === 'lever') {
    const accountSlug = url.pathname.split('/').filter(Boolean)[0];
    if (accountSlug !== undefined) {
      return accountSlug.replaceAll(/[-_]+/g, ' ');
    }
  }

  const hostname = url.hostname.replace(/^www\./, '');
  const firstLabel = hostname.split('.')[0];
  return firstLabel.replaceAll(/[-_]+/g, ' ');
}

function cleanDescription(value: unknown): string {
  return cleanText(value)
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&nbsp;/gi, ' ')
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;/gi, "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function cleanText(value: unknown): string {
  if (typeof value === 'number') {
    return String(value);
  }
  return typeof value === 'string' ? value.replaceAll(/\s+/g, ' ').trim() : '';
}

function optionalText(value: unknown): string | undefined {
  const cleaned = cleanText(value);
  return cleaned.length === 0 ? undefined : cleaned;
}

function requireText(value: unknown, source: JobSource, field: string): string {
  const result = cleanText(value);
  if (result.length === 0) {
    throw new JobImportError(`Job payload is missing ${field}`, source, field);
  }
  return result;
}

function parseTimestamp(value: string, source: JobSource, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new JobImportError(`${field} must be an ISO date-time`, source, field);
  }
  return parsed;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableSerialize(payload)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  const record = value as UnknownRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function optionalNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function matchAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attributes);
  return match?.[1];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonicalizeUrlUnchecked(value: string): string | undefined {
  try {
    return canonicalizeJobUrl(value, 'manual_url');
  } catch {
    return undefined;
  }
}

export function canonicalizeJobUrl(value: string, source: JobSource): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new JobImportError('Job URL must be absolute', source, 'url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new JobImportError('Job URL must use HTTP or HTTPS', source, 'url');
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  const retained = [...url.searchParams.entries()]
    .filter(([key]) => !/^(?:utm_.+|ref|referrer|source|gh_src)$/i.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      `${leftKey}=${leftValue}`.localeCompare(`${rightKey}=${rightValue}`),
    );
  url.search = '';
  for (const [key, parameterValue] of retained) {
    url.searchParams.append(key, parameterValue);
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}
