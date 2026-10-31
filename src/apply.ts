import {sql, type SQL} from 'drizzle-orm';
import type {Casing} from './columns.ts';
import type {Definition} from './definitions.ts';
import {buildSnapshot, idempotentStatements} from './snapshot.ts';

/** Any Drizzle Postgres database, or a transaction. */
export type Executor = {
	execute(query: SQL): PromiseLike<unknown>;
};

export type ApplyOptions = {
	/** The `casing` you pass to `drizzle()`. */
	readonly casing?: Casing;
};

/**
 * Creates or replaces every function and trigger in `definitions`, for tests and `drizzle-kit push`
 * setups that have no migrations. Safe to run again. Run it in a transaction to apply all or nothing.
 *
 * @example
 * await db.transaction(tx => applyDefinitions(tx, [postsUpdatedAt]));
 */
export async function applyDefinitions(executor: Executor, definitions: Iterable<Definition>, options: ApplyOptions = {}): Promise<void> {
	for (const statement of idempotentStatements(buildSnapshot(definitions, options.casing))) {
		await executor.execute(sql.raw(statement));
	}
}
