import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import Memory from "./ForkMigrations/001_ForkMemory.ts";
import Coordinators from "./ForkMigrations/002_ForkCoordinators.ts";

const loader = Migrator.fromRecord({ "1_ForkMemory": Memory, "2_ForkCoordinators": Coordinators });
const run = Migrator.make({});

export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_sql_migrations'`;
  if (tables.length === 0) return true;
  const [latest] = yield* sql<{
    readonly id: number | null;
  }>`SELECT MAX(migration_id) AS id FROM fork_sql_migrations`;
  return (latest?.id ?? 0) < 2;
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  if (!(yield* hasPendingForkMigrations())) return [];
  return yield* run({ loader, table: "fork_sql_migrations" });
});
