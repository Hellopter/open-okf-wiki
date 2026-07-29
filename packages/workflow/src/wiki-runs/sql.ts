/**
 * SQLite row helpers for WikiRuns (internal).
 */

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export function asRow(value: unknown): SqlRow | undefined {
  return value === undefined ? undefined : (value as SqlRow);
}

export function asRows(value: unknown): SqlRow[] {
  return value as SqlRow[];
}

export function sqliteBusy(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "ERR_SQLITE_ERROR" &&
    /database is locked|database is busy/i.test(value.message ?? "")
  );
}

export function parseJson<T>(value: SqlValue): T {
  if (typeof value !== "string") throw new Error("expected persisted JSON text");
  return JSON.parse(value) as T;
}

export function requiredText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`workflow database has invalid ${key}`);
  return value;
}

export function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`workflow database has invalid ${key}`);
  return value;
}
