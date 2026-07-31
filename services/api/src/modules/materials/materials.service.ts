import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import type { Fact } from '../profile';
import type { Review, ReviewFinding } from '../review';

import { diffMaterials } from './materials.diff';
import { MaterialsError } from './materials.errors';
import { exportMaterial } from './materials.export';
import { generateMaterialDraft } from './materials.generator';
import { validateMaterialDocument, type FactPolicyContext } from './materials.policy';
import { MaterialsRepository } from './materials.repository';
import type {
  GenerateMaterialInput,
  Material,
  MaterialAuditEvent,
  MaterialDiff,
  MaterialExport,
  MaterialExportFormat,
  ReviseMaterialInput,
} from './materials.types';

type Clock = () => string;
type IdFactory = () => string;

@Injectable()
export class MaterialsService {
  public constructor(
    @Optional()
    private readonly clock: Clock = () => new Date().toISOString(),
    @Optional()
    private readonly idFactory: IdFactory = () => randomUUID(),
    @Optional()
    @Inject(MaterialsRepository)
    private readonly repository: MaterialsRepository = new MaterialsRepository(':memory:'),
  ) {}

  public generate(input: GenerateMaterialInput): Material {
    const generated = generateMaterialDraft(input);
    const validation = validateMaterialDocument(
      generated.document,
      input.facts,
      policyContext(input),
      input.constraints,
    );
    const id = input.id ?? this.idFactory();
    if (!id.trim()) throw new MaterialsError('VALIDATION_FAILED', 'material id is required.');
    if (this.repository.hasMaterial(id)) {
      throw new MaterialsError('CONFLICT', `Material id already exists: ${id}`);
    }
    const now = this.clock();
    const material: Material = {
      id,
      user_id: input.user_id,
      ...(input.job_id ? { job_id: input.job_id } : {}),
      kind: input.kind,
      status: 'review_required',
      version: 1,
      file_ids: [...generated.file_ids],
      fact_citations: validation.citations,
      document: generated.document,
      checks: validation.checks,
      generation: generated.generation,
      created_at: now,
      updated_at: now,
    };
    this.repository.transaction(() => {
      this.save(material);
      this.recordAudit(material, 'material.draft_created', [
        'status',
        'document',
        'fact_citations',
        'checks',
      ]);
    });
    return clone(material);
  }

  public createDraft(input: GenerateMaterialInput): Material {
    return this.generate(input);
  }

  public revise(
    userId: string,
    materialId: string,
    expectedVersion: number,
    input: ReviseMaterialInput,
  ): Material {
    const current = this.requireMaterial(userId, materialId);
    this.assertVersion(current, expectedVersion);
    if (current.status === 'superseded' || current.status === 'rejected') {
      throw new MaterialsError(
        'STATE_TRANSITION_INVALID',
        `Material in ${current.status} cannot be revised.`,
      );
    }

    const generated = generateMaterialDraft({
      ...input,
      user_id: userId,
      job_id: current.job_id,
      kind: current.kind,
    });
    const validation = validateMaterialDocument(
      generated.document,
      input.facts,
      policyContext({ ...input, user_id: userId }),
      input.constraints,
    );
    const now = this.clock();

    if (current.status === 'approved') {
      const superseded: Material = {
        ...clone(current),
        status: 'superseded',
        version: current.version + 1,
        updated_at: now,
      };
      this.save(superseded);
      this.recordAudit(superseded, 'material.superseded', ['status']);

      const revised: Material = {
        id: this.idFactory(),
        user_id: userId,
        ...(current.job_id ? { job_id: current.job_id } : {}),
        kind: current.kind,
        status: 'review_required',
        version: 1,
        file_ids: generated.file_ids,
        fact_citations: validation.citations,
        supersedes_id: current.id,
        document: generated.document,
        checks: validation.checks,
        generation: generated.generation,
        created_at: now,
        updated_at: now,
      };
      this.save(revised);
      this.recordAudit(revised, 'material.draft_created', [
        'status',
        'supersedes_id',
        'document',
        'fact_citations',
        'checks',
      ]);
      return clone(revised);
    }

    if (current.status !== 'review_required' && current.status !== 'draft') {
      throw new MaterialsError(
        'STATE_TRANSITION_INVALID',
        `Material in ${current.status} cannot be revised.`,
      );
    }
    const revised: Material = {
      ...clone(current),
      status: 'review_required',
      version: current.version + 1,
      file_ids: generated.file_ids,
      fact_citations: validation.citations,
      document: generated.document,
      checks: validation.checks,
      generation: generated.generation,
      updated_at: now,
    };
    this.save(revised);
    this.recordAudit(revised, 'material.draft_revised', [
      'version',
      'document',
      'fact_citations',
      'checks',
    ]);
    return clone(revised);
  }

  public approve(
    userId: string,
    materialId: string,
    expectedVersion: number,
    facts: readonly Fact[],
    evaluatedAt: string,
    goalId: string | undefined,
    reviewId: string,
  ): Material {
    let current: Material | undefined;
    try {
      return this.repository.transaction(() => {
        current = this.requireMaterial(userId, materialId);
        this.assertVersion(current, expectedVersion);
        this.assertApprovalReview(userId, current, reviewId);
        if (current.status !== 'review_required') {
          throw new MaterialsError(
            'STATE_TRANSITION_INVALID',
            'Only review_required material can be approved.',
          );
        }
        if (!current.checks.publishable) {
          throw new MaterialsError(
            'MATERIAL_NOT_PUBLISHABLE',
            'Material has blocking format, citation, or confirmation issues.',
          );
        }

        const currentValidation = validateMaterialDocument(current.document, facts, {
          user_id: userId,
          goal_id: goalId,
          evaluated_at: evaluatedAt,
        });
        if (!currentValidation.checks.publishable) {
          throw new MaterialsError(
            'MATERIAL_NOT_PUBLISHABLE',
            'Material facts are no longer current, allowed, or traceable.',
          );
        }
        const approved: Material = {
          ...clone(current),
          status: 'approved',
          version: current.version + 1,
          fact_citations: currentValidation.citations,
          checks: { ...current.checks, publishable: true },
          updated_at: this.clock(),
        };
        this.save(approved);
        this.recordAudit(approved, 'material.approved', ['status', 'version'], 'succeeded');
        return clone(approved);
      });
    } catch (error) {
      if (error instanceof MaterialsError) {
        this.recordGateAudit(userId, materialId, error.code);
        throw error;
      }
      if (current) {
        this.repository.transaction(() =>
          this.recordAudit(
            current!,
            'material.approval_failed',
            [],
            'failed',
            'TRANSACTION_FAILED',
          ),
        );
      }
      throw new MaterialsError(
        'TRANSACTION_FAILED',
        'Approval transaction failed and was rolled back.',
      );
    }
  }

  public reject(userId: string, materialId: string, expectedVersion: number): Material {
    try {
      return this.repository.transaction(() => {
        const current = this.requireMaterial(userId, materialId);
        this.assertVersion(current, expectedVersion);
        if (current.status !== 'review_required') {
          throw new MaterialsError(
            'STATE_TRANSITION_INVALID',
            'Only review_required material can be rejected.',
          );
        }
        const rejected: Material = {
          ...clone(current),
          status: 'rejected',
          version: current.version + 1,
          updated_at: this.clock(),
        };
        this.save(rejected);
        this.recordAudit(rejected, 'material.rejected', ['status', 'version'], 'succeeded');
        return clone(rejected);
      });
    } catch (error) {
      if (error instanceof MaterialsError) {
        this.recordAuditFor(
          userId,
          materialId,
          'material.rejection_rejected',
          'rejected',
          error.code,
        );
      }
      throw error;
    }
  }

  public saveReview(review: Review): Review {
    if (!review.id.trim() || this.repository.findReview(review.id)) {
      throw new MaterialsError('CONFLICT', 'Review id already exists.');
    }
    if (
      !review.material_versions ||
      Object.keys(review.material_versions).length !== review.material_ids.length
    ) {
      throw new MaterialsError(
        'VALIDATION_FAILED',
        'Review must contain one immutable version snapshot for every material.',
      );
    }
    for (const materialId of review.material_ids) {
      const material = this.requireMaterial(review.user_id, materialId);
      if (review.material_versions[materialId] !== material.version) {
        throw new MaterialsError(
          'VALIDATION_FAILED',
          'Review material version snapshot must match the current material version.',
        );
      }
    }
    this.repository.insertReview(clone(review));
    return clone(review);
  }

  public getReview(userId: string, reviewId: string): Review {
    const review = this.repository.findReview(reviewId);
    if (!review || review.user_id !== userId) {
      throw new MaterialsError('RESOURCE_NOT_FOUND', 'Review not found.');
    }
    return clone(review);
  }

  public listReviews(userId: string): Review[] {
    return this.repository.listReviews(userId).map(clone);
  }

  public resolveReviewFinding(userId: string, reviewId: string, findingId: string): Review {
    const review = this.getReview(userId, reviewId);
    const finding = review.findings.find((candidate) => candidate.id === findingId);
    if (!finding) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Review finding not found.');
    if (finding.status !== 'open') return review;
    finding.status = 'resolved';
    review.version += 1;
    review.updated_at = this.clock();
    if (review.findings.every((candidate) => candidate.status !== 'open')) {
      review.status = 'approved';
      review.recommendation = 'approve';
    }
    this.repository.updateReview(clone(review));
    return clone(review);
  }

  public recordApprovalGateFailure(
    userId: string | undefined,
    materialId: string,
    reasonCode: string,
  ): void {
    this.recordAuditFor(userId, materialId, 'material.approval_rejected', 'rejected', reasonCode);
  }

  public recordRejectionGateFailure(
    userId: string | undefined,
    materialId: string,
    reasonCode: string,
  ): void {
    this.recordAuditFor(userId, materialId, 'material.rejection_rejected', 'rejected', reasonCode);
  }

  public get(userId: string, materialId: string, version?: number): Material {
    if (version === undefined) return clone(this.requireMaterial(userId, materialId));
    const material = this.repository.findMaterialVersion(materialId, version);
    if (!material) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Material not found.');
    return clone(material);
  }

  public list(userId: string, jobId?: string): Material[] {
    return this.repository
      .listCurrentMaterials(userId)
      .filter(
        (material) =>
          material.user_id === userId && (jobId === undefined || material.job_id === jobId),
      )
      .sort(
        (left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
          left.id.localeCompare(right.id),
      )
      .map(clone);
  }

  public getVersions(userId: string, materialId: string): Material[] {
    this.requireMaterial(userId, materialId);
    return this.repository.listMaterialVersions(materialId, userId).map(clone);
  }

  public diff(
    userId: string,
    fromId: string,
    fromVersion: number,
    toId: string,
    toVersion: number,
  ): MaterialDiff {
    return diffMaterials(this.get(userId, fromId, fromVersion), this.get(userId, toId, toVersion));
  }

  public export(
    userId: string,
    materialId: string,
    version: number,
    format: MaterialExportFormat,
  ): MaterialExport {
    const material = this.get(userId, materialId, version);
    if (material.status !== 'approved' || !material.checks.publishable) {
      throw new MaterialsError(
        'MATERIAL_NOT_PUBLISHABLE',
        'Only approved, publishable material can be exported.',
      );
    }
    const exported = exportMaterial(material, format);
    this.recordAudit(material, 'material.exported', []);
    return {
      ...exported,
      bytes: new Uint8Array(exported.bytes),
    };
  }

  public getAuditEvents(userId: string): MaterialAuditEvent[] {
    return this.repository.listAudit(userId).map(clone);
  }

  private requireMaterial(userId: string, materialId: string): Material {
    const material = this.repository.findCurrentMaterial(materialId);
    if (!material || material.user_id !== userId) {
      throw new MaterialsError('RESOURCE_NOT_FOUND', 'Material not found.');
    }
    return material;
  }

  private assertVersion(material: Material, expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new MaterialsError('VALIDATION_FAILED', 'expectedVersion must be a positive integer.');
    }
    if (material.version !== expectedVersion) {
      throw new MaterialsError('CONFLICT', 'Material version does not match expectedVersion.');
    }
  }

  private save(material: Material): void {
    try {
      this.repository.insertMaterial(clone(material));
    } catch (error) {
      if (error instanceof MaterialsError) throw error;
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new MaterialsError('CONFLICT', 'Material version already exists.');
      }
      throw error;
    }
  }

  private recordAudit(
    material: Material,
    action: MaterialAuditEvent['action'],
    changedFields: string[],
    outcome?: MaterialAuditEvent['outcome'],
    reasonCode?: string,
  ): void {
    this.repository.insertAudit({
      event_id: this.idFactory(),
      user_id: material.user_id,
      actor: { type: 'user', id: material.user_id },
      material_id: material.id,
      material_version: material.version,
      action,
      occurred_at: this.clock(),
      changed_fields: [...changedFields],
      ...(outcome ? { outcome } : {}),
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    });
  }

  private assertApprovalReview(userId: string, material: Material, reviewId: string): void {
    const review = reviewId ? this.repository.findReview(reviewId) : undefined;
    if (!review || review.user_id !== userId || !review.material_ids.includes(material.id)) {
      throw new MaterialsError('REVIEW_REQUIRED', 'An eligible server-side Review is required.');
    }
    if (review.findings.some((finding) => isOpenMustFix(finding))) {
      throw new MaterialsError(
        'REVIEW_HAS_OPEN_MUST_FIX',
        'Review contains an open must-fix finding.',
      );
    }
    if (review.status !== 'approved' || review.recommendation !== 'approve') {
      throw new MaterialsError('REVIEW_NOT_APPROVED', 'Review has not approved this material.');
    }
    if (review.material_versions?.[material.id] !== material.version) {
      throw new MaterialsError(
        'REVIEW_STALE',
        'Review does not match the current material version.',
      );
    }
    const materialEvidence = review.findings
      .flatMap((finding) => finding.evidence_refs)
      .filter((reference) => reference.type === 'material' && reference.id === material.id);
    if (
      materialEvidence.some(
        (reference) => reference.version !== undefined && reference.version !== material.version,
      )
    ) {
      throw new MaterialsError('REVIEW_STALE', 'Review evidence does not match material version.');
    }
  }

  private recordGateAudit(userId: string, materialId: string, reasonCode: string): void {
    this.recordAuditFor(userId, materialId, 'material.approval_rejected', 'rejected', reasonCode);
  }

  private recordAuditFor(
    userId: string | undefined,
    materialId: string,
    action: MaterialAuditEvent['action'],
    outcome: NonNullable<MaterialAuditEvent['outcome']>,
    reasonCode: string,
  ): void {
    const material = this.repository.findCurrentMaterial(materialId);
    const auditOwner = material?.user_id ?? userId;
    if (!auditOwner) return;
    this.repository.insertAudit({
      event_id: this.idFactory(),
      user_id: auditOwner,
      actor: userId ? { type: 'user', id: userId } : { type: 'system', id: 'anonymous' },
      material_id: materialId,
      material_version: material?.version ?? 0,
      action,
      occurred_at: this.clock(),
      changed_fields: [],
      outcome,
      reason_code: reasonCode,
    });
  }
}

function isOpenMustFix(finding: ReviewFinding): boolean {
  return finding.severity === 'must_fix' && finding.status === 'open';
}

function policyContext(input: {
  user_id: string;
  goal_id?: string;
  evaluated_at: string;
}): FactPolicyContext {
  return {
    user_id: input.user_id,
    goal_id: input.goal_id,
    evaluated_at: input.evaluated_at,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
