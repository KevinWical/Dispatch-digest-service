import { createHash } from "node:crypto";
import type { Connection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { migrations, runMigrations } from "../src/migrations.js";

function harness(rows: unknown[] = [], acquired: number | null = 1) {
  const query = vi.fn((sql: string) => {
    if (sql.includes("GET_LOCK")) return Promise.resolve([[{ acquired }], []]);
    if (sql.startsWith("SELECT id")) return Promise.resolve([rows, []]);
    return Promise.resolve([[], []]);
  });
  const execute = vi.fn().mockResolvedValue([{}, []]);
  return { query, execute, connection: { query, execute } as unknown as Connection };
}

function history() {
  return migrations.map(({ id, sql }) => ({
    id,
    checksum: createHash("sha256").update(sql).digest("hex"),
    completed_at: "2026-01-01 00:00:00.000000",
  }));
}

describe("database migrations", () => {
  it("applies in order and records completion only after each DDL succeeds", async () => {
    const { connection, query, execute } = harness();
    expect(await runMigrations(connection)).toEqual(migrations.map(({ id }) => id));
    for (const [index, migration] of migrations.entries()) {
      const ddlIndex = query.mock.calls.findIndex(([sql]) => sql === migration.sql);
      const ddlOrder = query.mock.invocationCallOrder[ddlIndex]!;
      expect(execute.mock.invocationCallOrder[index * 2]!).toBeLessThan(ddlOrder);
      expect(execute.mock.invocationCallOrder[index * 2 + 1]!).toBeGreaterThan(ddlOrder);
      expect(execute.mock.calls[index * 2]?.[1]).toEqual([
        migration.id, createHash("sha256").update(migration.sql).digest("hex"),
      ]);
    }
    expect(query.mock.calls.at(-1)?.[0]).toContain("RELEASE_LOCK");
  });

  it("does not reapply completed migrations", async () => {
    const { connection, query, execute } = harness(history());
    expect(await runMigrations(connection)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    for (const migration of migrations) {
      expect(query).not.toHaveBeenCalledWith(migration.sql);
    }
  });

  it("applies only the remaining migrations", async () => {
    const { connection, query } = harness(history().slice(0, 1));
    expect(await runMigrations(connection)).toEqual([migrations[1].id]);
    expect(query).not.toHaveBeenCalledWith(migrations[0].sql);
  });

  it.each([0, null])("stops when it cannot acquire the lock (%s)", async (acquired) => {
    const { connection, query, execute } = harness([], acquired);
    await expect(runMigrations(connection)).rejects.toThrow("database lock");
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...history()[0], checksum: "changed" },
    { ...history()[0], id: "unknown_migration" },
  ])("rejects mismatched history before any migration DDL", async (row) => {
    const { connection, query, execute } = harness([row]);
    await expect(runMigrations(connection)).rejects.toThrow("history mismatch");
    expect(execute).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toContain("RELEASE_LOCK");
  });

  it("refuses to automatically retry an interrupted migration", async () => {
    const { connection, execute } = harness([{ ...history()[0], completed_at: null }]);
    await expect(runMigrations(connection)).rejects.toThrow("is incomplete");
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves a failed DDL incomplete, stops subsequent migrations, and releases the lock", async () => {
    const { connection, query, execute } = harness();
    query.mockImplementation((sql) => {
      if (sql.includes("GET_LOCK")) return Promise.resolve([[{ acquired: 1 }], []]);
      if (sql === migrations[0].sql) return Promise.reject(new Error("DDL failure"));
      return Promise.resolve([[], []]);
    });
    await expect(runMigrations(connection)).rejects.toThrow("Migration 001_users failed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalledWith(migrations[1].sql);
    expect(query.mock.calls.at(-1)?.[0]).toContain("RELEASE_LOCK");
  });

  it("does not mark completion if the history update fails", async () => {
    const { connection, execute, query } = harness();
    execute.mockResolvedValueOnce([{}, []]).mockRejectedValueOnce(new Error("update failure"));
    await expect(runMigrations(connection)).rejects.toThrow("record remains incomplete");
    expect(query).not.toHaveBeenCalledWith(migrations[1].sql);
    expect(query.mock.calls.at(-1)?.[0]).toContain("RELEASE_LOCK");
  });
});
