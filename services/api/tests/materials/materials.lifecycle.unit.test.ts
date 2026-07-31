import { describe, expect, it } from 'vitest';

import {
  MaterialsError,
  MaterialsService,
  exportMaterial,
  generateMaterialDraft,
  selectBaseResume,
  validateMaterialDocument,
} from '../../src/modules/materials';
import type { Fact, FileMetadata } from '../../src/modules/profile';

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

  it('creates reproducible versions and line/claim differences', () => {
    const service = deterministicService();
    const firstFacts = materialFacts();
    const first = service.generate(generationInput(firstFacts));
    const secondFacts = firstFacts.map((item) =>
      item.kind === 'summary'
        ? {
            ...item,
            value: { summary: 'Backend engineer focused on resilient distributed systems.' },
            version: 2,
          }
        : item,
    );
    const second = service.revise(USER_ID, first.id, first.version, {
      goal_id: GOAL_ID,
      facts: secondFacts,
      evaluated_at: NOW,
    });

    expect(service.getVersions(USER_ID, first.id).map((item) => item.version)).toEqual([1, 2]);
    expect(service.get(USER_ID, first.id, 1)).toEqual(first);
    const left = service.diff(USER_ID, first.id, 1, second.id, 2);
    const right = service.diff(USER_ID, first.id, 1, second.id, 2);
    expect(left).toEqual(right);
    expect(left.added_claim_ids).toHaveLength(1);
    expect(left.removed_claim_ids).toHaveLength(1);
    expect(left.lines.some((line) => line.operation === 'delete')).toBe(true);
    expect(left.lines.some((line) => line.operation === 'insert')).toBe(true);
  });

  it('revalidates fact versions at approval and never mutates an approved version in place', () => {
    const service = deterministicService();
    const facts = materialFacts();
    const draft = service.generate(generationInput(facts));
    const changedFacts = facts.map((item) =>
      item.kind === 'education' ? { ...item, version: 2 } : item,
    );

    expect(() =>
      service.approve(USER_ID, draft.id, draft.version, changedFacts, NOW, GOAL_ID),
    ).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({
        code: 'MATERIAL_NOT_PUBLISHABLE',
      }),
    );

    const approved = service.approve(USER_ID, draft.id, draft.version, facts, NOW, GOAL_ID);
    const replacement = service.revise(USER_ID, approved.id, approved.version, {
      goal_id: GOAL_ID,
      facts,
      evaluated_at: NOW,
    });

    expect(approved).toMatchObject({ status: 'approved', version: 2 });
    expect(service.get(USER_ID, approved.id)).toMatchObject({
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

  it('blocks pending material approval and cross-tenant reads', () => {
    const service = deterministicService();
    const pending = service.generate({
      ...generationInput(materialFacts()),
      pending_claims: [{ text: 'Unconfirmed claim' }],
    });

    expect(() =>
      service.approve(USER_ID, pending.id, pending.version, materialFacts(), NOW, GOAL_ID),
    ).toThrowError(
      expect.objectContaining<Partial<MaterialsError>>({
        code: 'MATERIAL_NOT_PUBLISHABLE',
      }),
    );
    expect(() => service.get('another-user', pending.id)).toThrowError(
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

  it('exports approved text, DOCX and PDF as deterministic parseable payloads', () => {
    const service = deterministicService();
    const facts = materialFacts();
    const draft = service.generate(generationInput(facts));
    const approved = service.approve(USER_ID, draft.id, draft.version, facts, NOW, GOAL_ID);

    const text = service.export(USER_ID, approved.id, approved.version, 'text');
    const docx = service.export(USER_ID, approved.id, approved.version, 'docx');
    const pdf = service.export(USER_ID, approved.id, approved.version, 'pdf');

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

  it('preserves Unicode facts and all claims across multi-page PDF output', () => {
    const service = deterministicService();
    const facts = Array.from({ length: 35 }, (_, index) =>
      fact(index + 1, 'skill', { 技能名称: `分布式技能${index}` }),
    );
    const draft = service.generate(generationInput(facts));
    const approved = service.approve(USER_ID, draft.id, draft.version, facts, NOW, GOAL_ID);
    const pdf = service.export(USER_ID, approved.id, approved.version, 'pdf');
    const body = Buffer.from(pdf.bytes).toString('binary');

    expect(body).toContain('/Count 2');
    expect(body).toContain(`<${utf16BeHex('分布式技能34')}> Tj`);
    expect(body).toContain('/ToUnicode');
  });

  it('does not export a draft or a material with blocking checks', () => {
    const service = deterministicService();
    const draft = service.generate(generationInput(materialFacts()));
    expect(() => service.export(USER_ID, draft.id, draft.version, 'text')).toThrowError(
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

function deterministicService(): MaterialsService {
  let id = 0;
  let tick = 0;
  return new MaterialsService(
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
