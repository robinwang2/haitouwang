import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

import type { Review } from '../review';

import type { Material, MaterialAuditEvent } from './materials.types';

export type MaterialsWriteKind = 'material' | 'review' | 'audit';
export type MaterialsWriteObserver = (kind: MaterialsWriteKind) => void;

@Injectable()
export class MaterialsRepository implements OnModuleDestroy {
  private readonly database: DatabaseSync;

  public constructor(
    @Optional() databasePath = process.env.MATERIALS_DATABASE_PATH ?? defaultDatabasePath(),
    @Optional() private readonly beforeWrite: MaterialsWriteObserver = () => undefined,
  ) {
    if (databasePath !== ':memory:')
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS material_versions (
        material_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (material_id, version)
      );
      CREATE INDEX IF NOT EXISTS material_versions_owner
        ON material_versions (user_id, material_id, version DESC);
      CREATE TABLE IF NOT EXISTS reviews (
        review_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reviews_owner ON reviews (user_id, review_id);
      CREATE TABLE IF NOT EXISTS material_audit_events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        material_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS material_audit_owner
        ON material_audit_events (user_id, occurred_at, event_id);
    `);
  }

  public transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public hasMaterial(materialId: string): boolean {
    return (
      this.database
        .prepare('SELECT 1 FROM material_versions WHERE material_id = ? LIMIT 1')
        .get(materialId) !== undefined
    );
  }

  public insertMaterial(material: Material): void {
    this.beforeWrite('material');
    this.database
      .prepare(
        `INSERT INTO material_versions (material_id, user_id, version, updated_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        material.id,
        material.user_id,
        material.version,
        material.updated_at,
        serialize(material),
      );
  }

  public findCurrentMaterial(materialId: string): Material | undefined {
    return parseRow<Material>(
      this.database
        .prepare(
          `SELECT payload FROM material_versions
           WHERE material_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(materialId),
    );
  }

  public findMaterialVersion(materialId: string, version: number): Material | undefined {
    return parseRow<Material>(
      this.database
        .prepare('SELECT payload FROM material_versions WHERE material_id = ? AND version = ?')
        .get(materialId, version),
    );
  }

  public listCurrentMaterials(userId: string): Material[] {
    const rows = this.database
      .prepare(
        `SELECT current.payload
         FROM material_versions AS current
         WHERE current.user_id = ?
           AND current.version = (
             SELECT MAX(candidate.version)
             FROM material_versions AS candidate
             WHERE candidate.material_id = current.material_id
           )`,
      )
      .all(userId);
    return rows.map((row) => parseRequiredRow<Material>(row));
  }

  public listMaterialVersions(materialId: string, userId: string): Material[] {
    return this.database
      .prepare(
        `SELECT payload FROM material_versions
         WHERE material_id = ? AND user_id = ? ORDER BY version ASC`,
      )
      .all(materialId, userId)
      .map((row) => parseRequiredRow<Material>(row));
  }

  public insertReview(review: Review): void {
    this.beforeWrite('review');
    this.database
      .prepare('INSERT INTO reviews (review_id, user_id, payload) VALUES (?, ?, ?)')
      .run(review.id, review.user_id, serialize(review));
  }

  public updateReview(review: Review): void {
    this.beforeWrite('review');
    this.database
      .prepare('UPDATE reviews SET user_id = ?, payload = ? WHERE review_id = ?')
      .run(review.user_id, serialize(review), review.id);
  }

  public findReview(reviewId: string): Review | undefined {
    return parseRow<Review>(
      this.database.prepare('SELECT payload FROM reviews WHERE review_id = ?').get(reviewId),
    );
  }

  public listReviews(userId: string): Review[] {
    return this.database
      .prepare('SELECT payload FROM reviews WHERE user_id = ? ORDER BY review_id ASC')
      .all(userId)
      .map((row) => parseRequiredRow<Review>(row));
  }

  public insertAudit(event: MaterialAuditEvent): void {
    this.beforeWrite('audit');
    this.database
      .prepare(
        `INSERT INTO material_audit_events
           (event_id, user_id, material_id, occurred_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.event_id, event.user_id, event.material_id, event.occurred_at, serialize(event));
  }

  public listAudit(userId: string): MaterialAuditEvent[] {
    return this.database
      .prepare(
        `SELECT payload FROM material_audit_events
         WHERE user_id = ? ORDER BY rowid ASC`,
      )
      .all(userId)
      .map((row) => parseRequiredRow<MaterialAuditEvent>(row));
  }

  public onModuleDestroy(): void {
    this.database.close();
  }
}

function defaultDatabasePath(): string {
  return path.resolve(process.cwd(), 'data', 'materials.sqlite');
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parseRow<T>(row: unknown): T | undefined {
  if (!row) return undefined;
  return parseRequiredRow<T>(row);
}

function parseRequiredRow<T>(row: unknown): T {
  return JSON.parse(String((row as { payload: unknown }).payload)) as T;
}
