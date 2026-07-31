import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Job } from '../../src/modules/jobs';
import type { Material } from '../../src/modules/materials';
import {
  DEFAULT_REVIEW_EXECUTION_CONFIGURATION,
  HttpReviewerProvider,
  type ReviewContext,
  type ReviewProviderLog,
} from '../../src/modules/review';

const NOW = '2026-07-31T12:00:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '30000000-0000-4000-8000-000000000001';

describe('HTTP AI reviewer provider contract', () => {
  let server: Server;
  let endpoint: string;
  let handler: Parameters<typeof createServer>[0];
  let requestBodies: string[];

  beforeEach(async () => {
    requestBodies = [];
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ findings: [] }));
    };
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requestBodies.push(body);
        if (handler) handler(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('classifies timeout and fails closed within the configured upper bound', async () => {
    handler = () => undefined;
    const provider = providerWith({ timeoutMs: 20, maxAttempts: 1 });

    await expect(provider.review(context(), configuration())).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      userMessage: expect.stringContaining('Approval remains blocked'),
    });
  });

  it('retries one HTTP 429 with bounded Retry-After and then succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    handler = (_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(429, { 'retry-after': '30' });
        response.end('rate limited body must not be logged');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ findings: [] }));
    };
    const provider = providerWith({
      maximumBackoffMs: 25,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    await expect(provider.review(context(), configuration())).resolves.toMatchObject({
      reviewer: 'ats',
      findings: [],
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([25]);
  });

  it.each(['not-json', 'The material looks fine to me.'])(
    'classifies non-JSON provider text without exposing it: %s',
    async (body) => {
      handler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(body);
      };
      await expect(providerWith().review(context(), configuration())).rejects.toMatchObject({
        code: 'PROVIDER_MALFORMED_RESPONSE',
      });
    },
  );

  it('rejects JSON with missing required fields', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ summary: 'missing findings' }));
    };
    await expect(providerWith().review(context(), configuration())).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      userMessage: expect.stringContaining('omitted required review fields'),
    });
  });

  it('minimizes and redacts provider data and keeps content and credentials out of logs', async () => {
    const logs: ReviewProviderLog[] = [];
    const provider = providerWith({ logger: (entry) => logs.push(entry) });

    await provider.review(context(), configuration());

    const sent = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(USER_ID);
    expect(serialized).not.toContain('person@example.test');
    expect(serialized).not.toContain('+1 (585) 555-0100');
    expect(serialized).not.toContain('super-sensitive-value');
    expect(serialized).toContain('[redacted-email]');
    expect(serialized).toContain('[redacted-phone]');
    expect(sent).toMatchObject({
      data_policy: {
        profile_facts_sent: false,
        user_id_sent: false,
        source_records_sent: false,
        retention_requested: false,
      },
    });
    expect(JSON.stringify(logs)).not.toContain('fixture-provider-key');
    expect(JSON.stringify(logs)).not.toContain('person@example.test');
  });

  function providerWith(
    overrides: Partial<ConstructorParameters<typeof HttpReviewerProvider>[0]> = {},
  ) {
    return new HttpReviewerProvider({
      endpoint,
      apiKey: 'fixture-provider-key',
      reviewer: 'ats',
      timeoutMs: 200,
      maxAttempts: 2,
      ...overrides,
    });
  }
});

const smokeEnabled = process.env.REVIEW_PROVIDER_SMOKE === '1';

describe('explicit real-provider smoke/eval', () => {
  it.skipIf(!smokeEnabled)('returns a valid redacted reviewer report', async () => {
    const endpoint = requireEnvironment('REVIEW_PROVIDER_ENDPOINT');
    const apiKey = requireEnvironment('REVIEW_PROVIDER_API_KEY');
    const model = requireEnvironment('REVIEW_PROVIDER_MODEL');
    const provider = new HttpReviewerProvider({
      endpoint,
      apiKey,
      reviewer: 'ats',
      timeoutMs: 10_000,
      maxAttempts: 1,
    });
    const report = await provider.review(context(), { ...configuration(), model });

    console.info(
      JSON.stringify({
        smoke: 'review-provider',
        status: 'passed',
        reviewer: report.reviewer,
        finding_count: report.findings.length,
      }),
    );
    expect(report.reviewer).toBe('ats');
  });
});

function configuration() {
  return structuredClone(DEFAULT_REVIEW_EXECUTION_CONFIGURATION.reviewers.ats);
}

function context(): ReviewContext {
  return {
    user_id: USER_ID,
    job: job(),
    materials: [material()],
    facts: [],
    requirements: {
      required_skills: ['TypeScript person@example.test'],
      experience_keywords: ['password=super-sensitive-value'],
      work_authorization: 'not_required',
    },
    evaluated_at: NOW,
  };
}

function job(): Job {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    canonical_url: 'https://careers.example.test/job/1',
    source: 'company_careers',
    source_refs: [],
    title: 'Backend Engineer',
    company: 'Example Co',
    location: 'Remote',
    employment_type: 'full_time',
    description_status: 'complete',
    risk: { level: 'low', reasons: [], requires_manual_review: false },
    status: 'active',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function material(): Material {
  const text = 'Contact person@example.test or +1 (585) 555-0100. api_key=super-sensitive-value';
  return {
    id: MATERIAL_ID,
    user_id: USER_ID,
    job_id: '20000000-0000-4000-8000-000000000001',
    kind: 'resume',
    status: 'review_required',
    version: 1,
    file_ids: [],
    fact_citations: [],
    document: { kind: 'resume', sections: [], claims: [], plain_text: text },
    checks: {
      word_count: 7,
      character_count: text.length,
      ats_compatible: true,
      has_placeholders: false,
      publishable: true,
      issues: [],
    },
    generation: {
      strategy: 'deterministic_fact_template',
      external_model_calls: 0,
      input_characters: 0,
      output_characters: text.length,
      estimated_input_tokens: 0,
      estimated_output_tokens: 20,
    },
    created_at: NOW,
    updated_at: NOW,
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when REVIEW_PROVIDER_SMOKE=1.`);
  return value;
}
