import {getTableColumns, sql, type SQL} from 'drizzle-orm';
import {toCamelCase, toSnakeCase} from 'drizzle-orm/casing';
import * as pgCore from 'drizzle-orm/pg-core';
import type {PgColumn, PgTable} from 'drizzle-orm/pg-core';
import {quoteIdentifier} from './identifiers.ts';

/** The `casing` option of `drizzle()` and `drizzle.config.ts`. */
export type Casing = 'snake_case' | 'camelCase';

/** Column references for a trigger's `NEW` or `OLD` row, keyed like the table's columns. */
export type RowReferences<TTable extends PgTable> = {
	readonly [Key in keyof TTable['$inferSelect'] & string]: SQL;
};

/**
 * Drizzle 1.0 applies casing in the table builder (`snakeCase.table()`), so columns already carry their
 * database names, and drizzle-kit ignores the `casing` in `drizzle.config.ts`. Before 1.0, `casing` renames them.
 */
export const casingInTableBuilders = 'snakeCase' in pgCore;

/** The `casing` to apply to key-named columns: none when the installed Drizzle applies it in the table builder. */
export function effectiveCasing(casing: Casing | undefined, inTableBuilders = casingInTableBuilders): Casing | undefined {
	return inTableBuilders ? undefined : casing;
}

/**
 * The database name of `column`. A column declared without a name (`createdAt: timestamp()`) is named
 * after its key, and Drizzle's `casing` option renames it; a column with an explicit name keeps it.
 */
export function columnName(column: PgColumn, casing: Casing | undefined): string {
	if (!column.keyAsName || casing === undefined) {
		return column.name;
	}

	return casing === 'snake_case' ? toSnakeCase(column.name) : toCamelCase(column.name);
}

/** `NEW."updated_at"`-style references to every column of `table`, for a trigger's `WHEN` condition. */
export function rowReferences<TTable extends PgTable>(table: TTable, row: 'NEW' | 'OLD', casing: Casing | undefined): RowReferences<TTable> {
	const columns = getTableColumns(table) as Record<string, PgColumn>;
	const references = Object.fromEntries(Object.entries(columns).map(([key, column]) => [
		key,
		sql.raw(`${row}.${quoteIdentifier(columnName(column, casing))}`),
	]));
	return references as RowReferences<TTable>;
}
