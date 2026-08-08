import type {
  ResourceRef,
  ReviewContext,
  ReviewerAgent,
  ReviewerExecutionConfiguration,
  ReviewerFindingDraft,
  ReviewerReport,
} from './review.types';

export type ReviewProviderErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_UPSTREAM_ERROR';

export class ReviewProviderError extends Error {
  public constructor(
    public readonly code: ReviewProviderErrorCode,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'ReviewProviderError';
  }
}

export interface ReviewProviderLog {
  event: 'request_started' | 'request_retried' | 'request_completed' | 'request_failed';
  reviewer: string;
  attempt: number;
  status?: number;
  error_code?: ReviewProviderErrorCode;
}

export interface HttpReviewerProviderOptions {
  endpoint: string;
  apiKey: string;
  reviewer: ReviewerAgent['reviewer'];
  timeoutMs?: number;
  maxAttempts?: number;
  maximumBackoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: (entry: ReviewProviderLog) => void;
}

/**
 * External reviewer adapter. It sends only redacted, bounded job/material fields;
 * profile facts, user ids, source records, raw requests and credentials are excluded.
 */
export class HttpReviewerProvider implements ReviewerAgent {
  public readonly reviewer: ReviewerAgent['reviewer'];
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maximumBackoffMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: (entry: ReviewProviderLog) => void;

  public constructor(private readonly options: HttpReviewerProviderOptions) {
    this.reviewer = options.reviewer;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.maximumBackoffMs = options.maximumBackoffMs ?? 1_000;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.logger = options.logger ?? (() => undefined);
  }

  public async review(
    context: ReviewContext,
    configuration: ReviewerExecutionConfiguration,
  ): Promise<ReviewerReport> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.logger({ event: 'request_started', reviewer: this.reviewer, attempt });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(this.options.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(buildProviderPayload(context, configuration)),
          signal: controller.signal,
        });
        if (response.status === 429) {
          if (attempt < this.maxAttempts) {
            this.logger({
              event: 'request_retried',
              reviewer: this.reviewer,
              attempt,
              status: 429,
            });
            await this.sleep(
              retryDelay(response.headers.get('retry-after'), this.maximumBackoffMs),
            );
            continue;
          }
          throw providerError(
            'PROVIDER_RATE_LIMITED',
            'The independent review provider is busy. Try again later.',
          );
        }
        if (!response.ok) {
          throw providerError(
            'PROVIDER_UPSTREAM_ERROR',
            'The independent review provider is unavailable. Approval remains blocked.',
          );
        }
        const report = parseProviderResponse(await response.text(), this.reviewer, configuration);
        this.logger({
          event: 'request_completed',
          reviewer: this.reviewer,
          attempt,
          status: response.status,
        });
        return report;
      } catch (error) {
        const classified = classifyProviderError(error);
        this.logger({
          event: 'request_failed',
          reviewer: this.reviewer,
          attempt,
          error_code: classified.code,
        });
        throw classified;
      } finally {
        clearTimeout(timer);
      }
    }
    throw providerError(
      'PROVIDER_UPSTREAM_ERROR',
      'The independent review provider is unavailable.',
    );
  }
}

export function buildProviderPayload(
  context: ReviewContext,
  configuration: ReviewerExecutionConfiguration,
) {
  return {
    model: configuration.model,
    reviewer: configuration.reviewer,
    input: {
      job: {
        id: context.job.id,
        version: context.job.version,
        title: redact(context.job.title, 200),
        description_status: context.job.description_status,
        status: context.job.status,
        risk: context.job.risk,
      },
      materials: context.materials.map((material) => ({
        id: material.id,
        version: material.version,
        kind: material.kind,
        text: redact(material.document.plain_text, 4_000),
        checks: {
          ats_compatible: material.checks.ats_compatible,
          has_placeholders: material.checks.has_placeholders,
          publishable: material.checks.publishable,
        },
      })),
      requirements: {
        required_skills: context.requirements.required_skills.map((skill) => redact(skill, 100)),
        experience_keywords: context.requirements.experience_keywords.map((keyword) =>
          redact(keyword, 100),
        ),
        work_authorization: context.requirements.work_authorization,
      },
    },
    data_policy: {
      profile_facts_sent: false,
      user_id_sent: false,
      source_records_sent: false,
      retention_requested: false,
    },
  };
}

function parseProviderResponse(
  text: string,
  reviewer: ReviewerAgent['reviewer'],
  configuration: ReviewerExecutionConfiguration,
): ReviewerReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw providerError(
      'PROVIDER_MALFORMED_RESPONSE',
      'The independent review provider returned unreadable output. Approval remains blocked.',
    );
  }
  if (!isRecord(value) || !Array.isArray(value.findings)) {
    throw providerError(
      'PROVIDER_INVALID_RESPONSE',
      'The independent review provider omitted required review fields. Approval remains blocked.',
    );
  }
  const findings = value.findings;
  if (!findings.every(isFinding)) {
    throw providerError(
      'PROVIDER_INVALID_RESPONSE',
      'The independent review provider returned invalid review fields. Approval remains blocked.',
    );
  }
  return {
    reviewer,
    configuration_id: configuration.configuration_id,
    findings: structuredClone(findings),
  };
}

function isFinding(value: unknown): value is ReviewerFindingDraft {
  if (!isRecord(value)) return false;
  return (
    ['info', 'warning', 'must_fix'].includes(String(value.severity)) &&
    typeof value.category === 'string' &&
    value.category.trim().length > 0 &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    ['must_fix', 'auto_revision', 'human_review'].includes(String(value.disposition)) &&
    Array.isArray(value.evidence_refs) &&
    value.evidence_refs.length > 0 &&
    value.evidence_refs.every(isResourceRef)
  );
}

function isResourceRef(value: unknown): value is ResourceRef {
  return (
    isRecord(value) &&
    ['fact', 'material', 'job', 'review'].includes(String(value.type)) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    (value.version === undefined || (Number.isInteger(value.version) && Number(value.version) > 0))
  );
}

function classifyProviderError(error: unknown): ReviewProviderError {
  if (error instanceof ReviewProviderError) return error;
  if (isRecord(error) && error.name === 'AbortError') {
    return providerError(
      'PROVIDER_TIMEOUT',
      'The independent review provider timed out. Approval remains blocked.',
    );
  }
  return providerError(
    'PROVIDER_UPSTREAM_ERROR',
    'The independent review provider is unavailable. Approval remains blocked.',
  );
}

function providerError(code: ReviewProviderErrorCode, message: string): ReviewProviderError {
  return new ReviewProviderError(code, message);
}

function retryDelay(retryAfter: string | null, maximum: number): number {
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, maximum) : maximum;
}

function redact(value: string, maximumLength: number): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
    .replace(/(?:\+?\d[\d .()-]{7,}\d)/gu, '[redacted-phone]')
    .replace(/\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+/giu, '[redacted-secret]')
    .slice(0, maximumLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
