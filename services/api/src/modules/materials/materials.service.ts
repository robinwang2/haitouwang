import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import type { Fact } from '../profile';
import { ReviewService, type Review, type ReviewFinding } from '../review';

import { MATERIALS_STORE } from './materials-store.interface';
import type { MaterialsStore } from './materials-store.interface';
import { diffMaterials } from './materials.diff';
import { MaterialsError } from './materials.errors';
import { exportMaterial } from './materials.export';
import { generateMaterialDraft } from './materials.generator';
import { validateMaterialDocument, type FactPolicyContext } from './materials.policy';
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
    @Inject(MATERIALS_STORE) private readonly store: MaterialsStore,
    @Inject(ReviewService) private readonly reviews: ReviewService,
    @Optional() private readonly clock: Clock = () => new Date().toISOString(),
    @Optional() private readonly idFactory: IdFactory = () => randomUUID(),
  ) {}

  public async generate(input: GenerateMaterialInput): Promise<Material> {
    const generated = generateMaterialDraft(input);
    const validation = validateMaterialDocument(
      generated.document,
      input.facts,
      policyContext(input),
      input.constraints,
    );
    const id = input.id ?? this.idFactory();
    if (!id.trim()) throw new MaterialsError('VALIDATION_FAILED', 'material id is required.');
    if (await this.store.hasMaterial(input.user_id, id)) {
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
    await this.store.withTransaction(async (store) => {
      await this.save(store, material);
      await this.recordAudit(store, material, 'material.draft_created', [
        'status',
        'document',
        'fact_citations',
        'checks',
      ]);
    });
    return clone(material);
  }

  public createDraft(input: GenerateMaterialInput): Promise<Material> {
    return this.generate(input);
  }

  public async revise(
    userId: string,
    materialId: string,
    expectedVersion: number,
    input: ReviseMaterialInput,
  ): Promise<Material> {
    return this.store.withTransaction(async (store) => {
      const current = await this.requireMaterial(store, userId, materialId);
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
        await this.save(store, superseded);
        await this.recordAudit(store, superseded, 'material.superseded', ['status']);

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
        await this.save(store, revised);
        await this.recordAudit(store, revised, 'material.draft_created', [
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
      await this.save(store, revised);
      await this.recordAudit(store, revised, 'material.draft_revised', [
        'version',
        'document',
        'fact_citations',
        'checks',
      ]);
      return clone(revised);
    });
  }

  public async approve(
    userId: string,
    materialId: string,
    expectedVersion: number,
    facts: readonly Fact[],
    evaluatedAt: string,
    goalId: string | undefined,
    reviewId: string,
  ): Promise<Material> {
    let current: Material | undefined;
    try {
      return await this.store.withTransaction(async (store) => {
        current = await this.requireMaterial(store, userId, materialId);
        this.assertVersion(current, expectedVersion);
        await this.assertApprovalReview(userId, current, reviewId);
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
        await this.save(store, approved);
        await this.recordAudit(
          store,
          approved,
          'material.approved',
          ['status', 'version'],
          'succeeded',
        );
        return clone(approved);
      });
    } catch (error) {
      if (error instanceof MaterialsError) {
        await this.recordGateAudit(userId, materialId, error.code);
        throw error;
      }
      if (current) {
        await this.store.withTransaction((store) =>
          this.recordAudit(
            store,
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

  public async reject(
    userId: string,
    materialId: string,
    expectedVersion: number,
  ): Promise<Material> {
    let current: Material | undefined;
    try {
      return await this.store.withTransaction(async (store) => {
        current = await this.requireMaterial(store, userId, materialId);
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
        await this.save(store, rejected);
        await this.recordAudit(
          store,
          rejected,
          'material.rejected',
          ['status', 'version'],
          'succeeded',
        );
        return clone(rejected);
      });
    } catch (error) {
      if (error instanceof MaterialsError) {
        await this.recordAuditFor(
          userId,
          materialId,
          'material.rejection_rejected',
          'rejected',
          error.code,
        );
        throw error;
      }
      if (current) {
        await this.store.withTransaction((store) =>
          this.recordAudit(
            store,
            current!,
            'material.rejection_failed',
            [],
            'failed',
            'TRANSACTION_FAILED',
          ),
        );
      }
      throw new MaterialsError(
        'TRANSACTION_FAILED',
        'Rejection transaction failed and was rolled back.',
      );
    }
  }

  public async saveReview(review: Review): Promise<Review> {
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
      const material = await this.requireMaterial(this.store, review.user_id, materialId);
      if (review.material_versions[materialId] !== material.version) {
        throw new MaterialsError(
          'VALIDATION_FAILED',
          'Review material version snapshot must match the current material version.',
        );
      }
    }
    return this.reviews.save(review);
  }

  public getReview(userId: string, reviewId: string): Promise<Review> {
    return this.reviews.get(userId, reviewId);
  }

  public listReviews(userId: string): Promise<Review[]> {
    return this.reviews.list(userId);
  }

  public resolveReviewFinding(
    userId: string,
    reviewId: string,
    findingId: string,
  ): Promise<Review> {
    return this.reviews.resolveFinding(userId, reviewId, findingId);
  }

  public recordApprovalGateFailure(
    userId: string | undefined,
    materialId: string,
    reasonCode: string,
  ): Promise<void> {
    return this.recordAuditFor(
      userId,
      materialId,
      'material.approval_rejected',
      'rejected',
      reasonCode,
    );
  }

  public recordRejectionGateFailure(
    userId: string | undefined,
    materialId: string,
    reasonCode: string,
  ): Promise<void> {
    return this.recordAuditFor(
      userId,
      materialId,
      'material.rejection_rejected',
      'rejected',
      reasonCode,
    );
  }

  public async get(userId: string, materialId: string, version?: number): Promise<Material> {
    if (version === undefined) {
      return clone(await this.requireMaterial(this.store, userId, materialId));
    }
    const material = await this.store.getMaterialVersion(userId, materialId, version);
    if (!material) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Material not found.');
    return clone(material);
  }

  public async list(userId: string, jobId?: string): Promise<Material[]> {
    return (await this.store.listCurrentMaterials(userId))
      .filter((material) => jobId === undefined || material.job_id === jobId)
      .sort(
        (left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
          left.id.localeCompare(right.id),
      )
      .map(clone);
  }

  public async getVersions(userId: string, materialId: string): Promise<Material[]> {
    await this.requireMaterial(this.store, userId, materialId);
    return (await this.store.listMaterialVersions(userId, materialId)).map(clone);
  }

  public async diff(
    userId: string,
    fromId: string,
    fromVersion: number,
    toId: string,
    toVersion: number,
  ): Promise<MaterialDiff> {
    const [from, to] = await Promise.all([
      this.get(userId, fromId, fromVersion),
      this.get(userId, toId, toVersion),
    ]);
    return diffMaterials(from, to);
  }

  public async export(
    userId: string,
    materialId: string,
    version: number,
    format: MaterialExportFormat,
  ): Promise<MaterialExport> {
    const material = await this.get(userId, materialId, version);
    if (material.status !== 'approved' || !material.checks.publishable) {
      throw new MaterialsError(
        'MATERIAL_NOT_PUBLISHABLE',
        'Only approved, publishable material can be exported.',
      );
    }
    const exported = exportMaterial(material, format);
    await this.recordAudit(this.store, material, 'material.exported', []);
    return { ...exported, bytes: new Uint8Array(exported.bytes) };
  }

  public async getAuditEvents(userId: string): Promise<MaterialAuditEvent[]> {
    return (await this.store.listAuditEvents(userId)).map(clone);
  }

  private async requireMaterial(
    store: MaterialsStore,
    userId: string,
    materialId: string,
  ): Promise<Material> {
    const material = await store.getCurrentMaterial(userId, materialId);
    if (!material) throw new MaterialsError('RESOURCE_NOT_FOUND', 'Material not found.');
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

  private async save(store: MaterialsStore, material: Material): Promise<void> {
    try {
      await store.saveMaterial(material.user_id, clone(material));
    } catch (error) {
      if (error instanceof MaterialsError) throw error;
      if (
        (Boolean(error) &&
          typeof error === 'object' &&
          (error as { code?: string }).code === '23505') ||
        String(error).includes('already exists')
      ) {
        throw new MaterialsError('CONFLICT', 'Material version already exists.');
      }
      throw error;
    }
  }

  private recordAudit(
    store: MaterialsStore,
    material: Material,
    action: MaterialAuditEvent['action'],
    changedFields: string[],
    outcome?: MaterialAuditEvent['outcome'],
    reasonCode?: string,
  ): Promise<void> {
    return store.appendAuditEvent(material.user_id, {
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

  private async assertApprovalReview(
    userId: string,
    material: Material,
    reviewId: string,
  ): Promise<void> {
    const review = reviewId ? await this.reviews.find(userId, reviewId) : undefined;
    if (!review || !review.material_ids.includes(material.id)) {
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

  private recordGateAudit(userId: string, materialId: string, reasonCode: string): Promise<void> {
    return this.recordAuditFor(
      userId,
      materialId,
      'material.approval_rejected',
      'rejected',
      reasonCode,
    );
  }

  private recordAuditFor(
    userId: string | undefined,
    materialId: string,
    action: MaterialAuditEvent['action'],
    outcome: NonNullable<MaterialAuditEvent['outcome']>,
    reasonCode: string,
  ): Promise<void> {
    return this.store.appendRejectedAuditEvent(userId, materialId, {
      event_id: this.idFactory(),
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
