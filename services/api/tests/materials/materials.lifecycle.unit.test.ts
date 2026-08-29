import { describe, expect, it } from 'vitest';

import {
  MaterialsError,
  MaterialsService,
  InMemoryMaterialsStore,
  exportMaterial,
  generateMaterialDraft,
  selectBaseResume,
  validateMaterialDocument,
} from '../../src/modules/materials';
import type { Fact, FileMetadata } from '../../src/modules/profile';
import type { Material } from '../../src/modules/materials';
import { InMemoryReviewStore, ReviewService } from '../../src/modules/review';

import { GOAL_ID, NOW, USER_ID, fact, materialFacts } from './fixtures/material-facts';

describe('material formatting, versions and lifecycle', () => {
  it('detects placeholders, ATS-unsafe markup and deterministic word constraints', () => {
    const facts = [
      fact(1, 'summary', { text: 'Experienced {{ROLE}} engineer.' }),
      fact(2, 'summary', { text: '<script>unsafe</script>' }),
    ];
    const generated = generateMaterialDraft({
      user_id: USER_ID,
      goal_id: GOAL_ID,
      kind: 'resume',
      facts,
      evaluated_at: NOW,
      constraints: { maximum_words: 2 },
    });
    const validation = validateMaterialDocument(
      generated.document,
      facts,
      { user_id: USER_ID, goal_id: GOAL_ID, evaluated_at: NOW },
      { maximum_words: 2 },
    );

    expect(validation.checks).toMatchObject({
      has_placeholders: true,
      ats_compatible: false,
      publishable: false,
    });
    expect(validation.checks.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'PLACEHOLDER_REMAINS',
        'ATS_UNSAFE_CONTENT',
        'WORD_COUNT_ABOVE_MAXIMUM',
      ]),
    );
  });

  it('does not mark an empty factual document as publishable', () => {
    const generated = generateMaterialDraft({
      user_id: USER_ID,
      goal_id: GOAL_ID,
      kind: 'resume',
      facts: [],
      evaluated_at: NOW,
    });
    const validation = validateMaterialDocument(generated.document, [], {
      user_id: USER_ID,
      goal_id: GOAL_ID,
      evaluated_at: NOW,
    });

    expect(validation.checks.publishable).toBe(false);
    expect(validation.checks.issues.some((issue) => issue.code === 'CLAIM_NOT_TRACEABLE')).toBe(
      true,
    );
  });

  it('creates reproducible versions and line/claim differences', async () => {
    const service = deterministicService();
    const firstFacts = materialFacts();
    const first = await service.generate(generationInput(firstFacts));
    const secondFacts = firstFacts.map((item) =>
      item.kind === 'summary'
        ? {
            ...item,
            value: { summary: 'Backend engineer focused on resilient distributed systems.' },
            version: 2,
          }
        : item,
    );
    const second = await service.revise(USER_ID, first.id, first.version, {
      goal_id: GOAL_ID,
      facts: secondFacts,
      evaluated_at: NOW,
    });

    expect((await service.getVersions(USER_ID, first.id)).map((item) => item.version)).toEqual([
      1, 2,
    ]);
    expect(await service.get(USER_ID, first.id, 1)).toEqual(first);
    const left = await service.diff(USER_ID, first.id, 1, second.id, 2);
    const right = await service.diff(USER_ID, first.id, 1, second.id, 2);
    expect(left).toEqual(right);
    expect(left.added_claim_ids).toHaveLength(1);
    expect(left.removed_claim_ids).toHaveLength(1);
    expect(left.lines.some((line) => line.operation === 'delete')).toBe(true);
    expect(left.lines.some((line) => line.operation === 'insert')).toBe(true);
  });

  it('revalidates fact versions at approval and never mutates an approved version in place', async () => {
    const service = deterministicService();
    const facts = materialFacts();
    const draft = await service.generate(generationInput(facts));
    const changedFacts = facts.map((item) =>
      item.kind === 'education' ? { ...item, version: 2 } : item,
    );

    await expect(approveMaterial(service, draft, changedFacts)).rejects.toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({
        code: 'MATERIAL_NOT_PUBLISHABLE',
      }),
    );

    const approved = await approveMaterial(service, draft, facts);
    const replacement = await service.revise(USER_ID, approved.id, approved.version, {
      goal_id: GOAL_ID,
      facts,
      evaluated_at: NOW,
    });

    expect(approved).toMatchObject({ status: 'approved', version: 2 });
    expect(await service.get(USER_ID, approved.id)).toMatchObject({
      status: 'superseded',
      version: 3,
    });
    expect(replacement).toMatchObject({
      status: 'review_required',
      version: 1,
      supersedes_id: approved.id,
    });
    expect(replacement.id).not.toBe(approved.id);
  });

  it('blocks pending material approval and cross-tenant reads', async () => {
    const service = deterministicService();
    const pending = await service.generate({
      ...generationInput(materialFacts()),
      pending_claims: [{ text: 'Unconfirmed claim' }],
    });

    await expect(approveMaterial(service, pending, materialFacts())).rejects.toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({
        code: 'MATERIAL_NOT_PUBLISHABLE',
      }),
    );
    await expect(service.get('another-user', pending.id)).rejects.toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({ code: 'RESOURCE_NOT_FOUND' }),
    );
  });
});

describe('material base resume and exports', () => {
  it('selects only a clean tenant-owned resume and honors an explicit safe selection', () => {
    const files: FileMetadata[] = [
      resumeFile('file-old', '2026-01-01T00:00:00.000Z', 'clean'),
      resumeFile('file-new', '2026-07-01T00:00:00.000Z', 'clean'),
      resumeFile('file-pending', '2026-07-30T00:00:00.000Z', 'pending'),
      resumeFile('file-other', '2026-07-31T00:00:00.000Z', 'clean', 'another-user'),
    ];

    expect(selectBaseResume(USER_ID, files)?.id).toBe('file-new');
    expect(selectBaseResume(USER_ID, files, 'file-old')?.id).toBe('file-old');
    expect(() => selectBaseResume(USER_ID, files, 'file-pending')).toThrow(MaterialsError);
  });

  it('exports approved text, DOCX and PDF as deterministic parseable payloads', async () => {
    const service = deterministicService();
    const facts = materialFacts();
    const draft = await service.generate(generationInput(facts));
    const approved = await approveMaterial(service, draft, facts);

    const text = await service.export(USER_ID, approved.id, approved.version, 'text');
    const docx = await service.export(USER_ID, approved.id, approved.version, 'docx');
    const pdf = await service.export(USER_ID, approved.id, approved.version, 'pdf');

    expect(Buffer.from(text.bytes).toString('utf8')).toBe(approved.document.plain_text);
    expect(Buffer.from(docx.bytes).subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(listStoredZipFiles(docx.bytes)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    expect(Buffer.from(pdf.bytes).subarray(0, 8).toString('binary')).toBe('%PDF-1.4');
    expect(Buffer.from(pdf.bytes).toString('binary').endsWith('%%EOF\n')).toBe(true);
    expect(text.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(exportMaterial(approved, 'docx').bytes).toEqual(exportMaterial(approved, 'docx').bytes);
  });

  it('preserves Unicode facts and all claims across multi-page PDF output', async () => {
    const service = deterministicService();
    const facts = Array.from({ length: 35 }, (_, index) =>
      fact(index + 1, 'skill', { 技能名称: `分布式技能${index}` }),
    );
    const draft = await service.generate(generationInput(facts));
    const approved = await approveMaterial(service, draft, facts);
    const pdf = await service.export(USER_ID, approved.id, approved.version, 'pdf');
    const body = Buffer.from(pdf.bytes).toString('binary');

    expect(body).toContain('/Count 2');
    expect(body).toContain(`<${utf16BeHex('分布式技能34')}> Tj`);
    expect(body).toContain('/ToUnicode');
  });

  it('does not export a draft or a material with blocking checks', async () => {
    const service = deterministicService();
    const draft = await service.generate(generationInput(materialFacts()));
    await expect(service.export(USER_ID, draft.id, draft.version, 'text')).rejects.toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({
        code: 'MATERIAL_NOT_PUBLISHABLE',
      }),
    );
  });
});

function generationInput(facts: readonly Fact[]) {
  return {
    user_id: USER_ID,
    goal_id: GOAL_ID,
    job_id: '30000000-0000-4000-8000-000000000001',
    kind: 'resume' as const,
    facts,
    evaluated_at: NOW,
  };
}

async function approveMaterial(
  service: MaterialsService,
  material: Material,
  facts: readonly Fact[],
): Promise<Material> {
  let review = (await service.listReviews(USER_ID)).find((candidate) =>
    candidate.material_ids.includes(material.id),
  );
  if (!review) {
    review = await service.saveReview({
      id: `80000000-0000-4000-8000-${material.id.slice(-12)}`,
      user_id: USER_ID,
      job_id: material.job_id!,
      material_ids: [material.id],
      material_versions: { [material.id]: material.version },
      status: 'approved',
      reviewers: ['ats', 'hard_requirements', 'fact_check', 'naturalness'],
      findings: [],
      recommendation: 'approve',
      round: 1,
      version: 3,
      created_at: NOW,
      updated_at: NOW,
    });
  }
  return service.approve(USER_ID, material.id, material.version, facts, NOW, GOAL_ID, review.id);
}

function deterministicService(): MaterialsService {
  let id = 0;
  let tick = 0;
  const reviews = new ReviewService(new InMemoryReviewStore());
  return new MaterialsService(
    new InMemoryMaterialsStore(),
    reviews,
    () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString(),
    () => `90000000-0000-4000-8000-${(++id).toString().padStart(12, '0')}`,
  );
}

function resumeFile(
  id: string,
  createdAt: string,
  scanStatus: FileMetadata['scan_status'],
  userId = USER_ID,
): FileMetadata {
  return {
    id,
    user_id: userId,
    purpose: 'resume_source',
    display_name: `${id}.docx`,
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byte_size: 100,
    sha256: 'a'.repeat(64),
    scan_status: scanStatus,
    version: 1,
    created_at: createdAt,
  };
}

function listStoredZipFiles(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  const files: string[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    files.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return files;
}

function utf16BeHex(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    result += value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  }
  return result;
}
