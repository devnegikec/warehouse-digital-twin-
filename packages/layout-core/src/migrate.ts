/**
 * schemaVersion migrations.
 *
 * Adding a field with a default does NOT require a version bump — old documents
 * still parse. Bumping `schemaVersion` is for changes that alter meaning:
 * renaming a field, changing a unit, or changing a default that shifts geometry.
 *
 * Every migration must have a mirror in `server/app/layout/migrate.py`.
 */
import { LayoutDocSchema, type LayoutDoc } from './schema.js';

export const CURRENT_SCHEMA_VERSION = 1;

export type MigrationResult = { doc: LayoutDoc; migratedFrom: number | null };

/** Raw, pre-parse shape: only `schemaVersion` is assumed present. */
export function migrateToCurrent(input: unknown): MigrationResult {
  const version =
    typeof input === 'object' && input !== null && 'schemaVersion' in input
      ? (input as { schemaVersion: unknown }).schemaVersion
      : undefined;

  if (version === undefined) {
    throw new Error('Document is missing schemaVersion');
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error(`schemaVersion must be an integer, received ${String(version)}`);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Document schemaVersion ${version} is newer than this build supports (${CURRENT_SCHEMA_VERSION})`,
    );
  }

  // No migrations exist yet. When version 2 arrives:
  //   if (version < 2) { migrated = v1ToV2(input); }
  const doc = LayoutDocSchema.parse(input);
  return { doc, migratedFrom: version === CURRENT_SCHEMA_VERSION ? null : version };
}
