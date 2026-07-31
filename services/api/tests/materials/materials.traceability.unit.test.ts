import { describe, expect, it } from 'vitest';

import {
  generateMaterialDraft,
  isFactAllowed,
  renderMaterialDocumentText,
  validateMaterialDocument,
  type GenerateMaterialInput,
  type MaterialDocument,
} from '../../src/modules/materials';
import type { MaterialsError } from '../../src/modules/materials';

import {
  GOAL_ID,
  NOW,
  OTHER_GOAL_ID,
  OTHER_USER_ID,
  USER_ID,
  fact,
  materialFacts,
} from './fixtures/material-facts';

function input(
  kind: GenerateMaterialInput['kind'],
  overrides: Partial<GenerateMaterialInput> = {},
): GenerateMaterialInput {
  return {
    user_id: USER_ID,
    goal_id: GOAL_ID,
    job_id: '30000000-0000-4000-8000-000000000001',
    kind,
    facts: materialFacts(),
    evaluated_at: NOW,
    ...overrides,
  };
}

describe('material statement traceability', () => {
  it.each(['resume', 'cover_letter', 'open_question_answer'] as const)(
    'generates every %s claim from an exact allowed fact value',
    (kind) => {
      const generated = generateMaterialDraft(
        input(kind, kind === 'open_question_answer' ? { open_question: 'Why this role?' } : {}),
      );
      const validation = validateMaterialDocument(generated.document, materialFacts(), {
        user_id: USER_ID,
        goal_id: GOAL_ID,
        evaluated_at: NOW,
      });

      expect(generated.document.claims.length).toBeGreaterThan(0);
      expect(validation.checks.publishable).toBe(true);
      expect(validation.citations).toHaveLength(generated.document.claims.length);
      expect(generated.document.claims.every((claim) => claim.citations.length === 1)).toBe(true);
      expect(
        validation.evidence.every((item) =>
          generated.document.claims.some(
            (claim) =>
              claim.text === item.value &&
              claim.citations.some(
                (citation) =>
                  citation.fact_id === item.citation.fact_id &&
                  citation.fact_version === item.citation.fact_version &&
                  citation.claim_path === item.citation.claim_path,
              ),
          ),
        ),
      ).toBe(true);
    },
  );

  it('has zero generated recall for unconfirmed, expired, prohibited, cross-tenant and out-of-scope facts', () => {
    const facts = [
      fact(1, 'skill', { name: 'AllowedSkill' }),
      fact(2, 'skill', { name: 'PendingSkill' }, { status: 'pending_confirmation' }),
      fact(3, 'skill', { name: 'ExpiredSkill' }, { status: 'expired' }),
      fact(4, 'skill', { name: 'ProhibitedSkill' }, { scope: { use: 'prohibited' } }),
      fact(5, 'skill', { name: 'ManualSkill' }, { scope: { use: 'manual_only' } }),
      fact(
        6,
        'skill',
        { name: 'OtherGoalSkill' },
        { scope: { use: 'selected_goals', goal_ids: [OTHER_GOAL_ID] } },
      ),
      fact(7, 'skill', { name: 'OtherTenantSkill' }, { user_id: OTHER_USER_ID }),
      fact(8, 'skill', { name: 'PastSkill' }, { valid_until: NOW }),
      fact(9, 'skill', { name: 'FutureSkill' }, { valid_from: '2026-08-01T00:00:00.000Z' }),
    ];

    const generated = generateMaterialDraft(input('resume', { facts }));

    expect(generated.document.claims.map((claim) => claim.text)).toEqual(['AllowedSkill']);
    expect(
      facts.slice(1).every(
        (candidate) =>
          !isFactAllowed(candidate, {
            user_id: USER_ID,
            goal_id: GOAL_ID,
            evaluated_at: NOW,
          }),
      ),
    ).toBe(true);
  });

  it('rejects an explicitly requested disallowed fact instead of silently using it', () => {
    const prohibited = fact(9, 'skill', { name: 'SecretSkill' }, { scope: { use: 'prohibited' } });

    expect(() =>
      generateMaterialDraft(
        input('resume', {
          facts: [prohibited],
          fact_ids: [prohibited.id],
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'FACT_POLICY_VIOLATION' }),
    );
  });

  it('supports non-ASCII fact field paths without losing provenance', () => {
    const facts = [fact(10, 'skill', { 技能名称: '分布式系统' })];
    const generated = generateMaterialDraft(input('resume', { facts }));
    const validation = validateMaterialDocument(generated.document, facts, {
      user_id: USER_ID,
      goal_id: GOAL_ID,
      evaluated_at: NOW,
    });

    expect(generated.document.claims[0]).toMatchObject({
      text: '分布式系统',
      citations: [{ claim_path: 'value.技能名称' }],
    });
    expect(validation.checks.publishable).toBe(true);
  });
});

describe('fixed anti-hallucination fixtures', () => {
  it.each([
    ['school', 'Imaginary University'],
    ['gpa', '4.00'],
    ['company', 'Invented Corporation'],
    ['start_date', '2018-01'],
    ['end_date', 'Present'],
    ['name', 'TypeScript | Rust'],
  ])('blocks altered or newly added critical fact: %s', (field, replacement) => {
    const facts = materialFacts();
    const generated = generateMaterialDraft(input('resume', { facts }));
    const document = structuredClone(generated.document);
    const target = findClaim(document, field, field === 'name' ? 'TypeScript' : undefined);
    target.text = replacement;
    document.plain_text = document.plain_text.replace(
      field === 'name' ? 'TypeScript' : originalValue(facts, target.citations[0]!.fact_id, field),
      replacement,
    );

    const validation = validateMaterialDocument(document, facts, {
      user_id: USER_ID,
      goal_id: GOAL_ID,
      evaluated_at: NOW,
    });

    expect(validation.checks.publishable).toBe(false);
    expect(validation.checks.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FACT_TEXT_ALTERED',
          severity: 'blocking',
          claim_id: target.id,
        }),
      ]),
    );
  });

  it('keeps uncited pending text visibly blocked from publication', () => {
    const generated = generateMaterialDraft(
      input('cover_letter', {
        pending_claims: [{ text: 'Led an unconfirmed team of 20 engineers.' }],
      }),
    );
    const validation = validateMaterialDocument(generated.document, materialFacts(), {
      user_id: USER_ID,
      goal_id: GOAL_ID,
      evaluated_at: NOW,
    });

    expect(generated.document.claims.at(-1)).toMatchObject({
      status: 'pending_confirmation',
      citations: [],
    });
    expect(validation.checks.publishable).toBe(false);
    expect(validation.checks.issues.some((issue) => issue.code === 'PENDING_CONFIRMATION')).toBe(
      true,
    );
  });

  it('blocks unstructured text appended outside the cited claim graph', () => {
    const facts = materialFacts();
    const generated = generateMaterialDraft(input('resume', { facts }));
    generated.document.plain_text += '\n\nInvented uncited achievement.';

    const validation = validateMaterialDocument(generated.document, facts, {
      user_id: USER_ID,
      goal_id: GOAL_ID,
      evaluated_at: NOW,
    });

    expect(validation.checks.publishable).toBe(false);
    expect(validation.checks.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'DOCUMENT_TEXT_MISMATCH',
          severity: 'blocking',
        }),
      ]),
    );
  });

  it.each([
    ['title', (document: MaterialDocument) => (document.title = 'GPA 4.00')],
    [
      'section heading',
      (document: MaterialDocument) => (document.sections[0]!.heading = 'Invented Corporation'),
    ],
  ])('blocks a newly added critical fact in the %s', (_location, mutate) => {
    const facts = materialFacts();
    const generated = generateMaterialDraft(input('resume', { facts }));
    mutate(generated.document);
    generated.document.plain_text = renderMaterialDocumentText(generated.document);

    const validation = validateMaterialDocument(generated.document, facts, {
      user_id: USER_ID,
      goal_id: GOAL_ID,
      evaluated_at: NOW,
    });

    expect(validation.checks.publishable).toBe(false);
    expect(validation.checks.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STRUCTURE_INVALID', severity: 'blocking' }),
      ]),
    );
  });
});

function findClaim(document: MaterialDocument, field: string, text?: string) {
  const claim = document.claims.find(
    (candidate) =>
      candidate.citations[0]?.claim_path === `value.${field}` &&
      (text === undefined || candidate.text === text),
  );
  if (!claim) throw new Error(`Missing fixture claim for ${field}`);
  return claim;
}

function originalValue(
  facts: ReturnType<typeof materialFacts>,
  factId: string,
  field: string,
): string {
  const value = facts.find((candidate) => candidate.id === factId)?.value[field];
  if (value === undefined || value === null) throw new Error(`Missing fixture value for ${field}`);
  return String(value);
}
