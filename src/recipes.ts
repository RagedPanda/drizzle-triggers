import {toSnakeCase} from 'drizzle-orm/casing';
import {getTableConfig, type PgColumn, type PgTable} from 'drizzle-orm/pg-core';
import {columnName} from './columns.ts';
import {forCasing, pgFunction, pgTrigger, type PgFunctionDefinition, type PgTriggerDefinition} from './definitions.ts';
import {assertIdentifier, quoteIdentifier} from './identifiers.ts';

/** One function per column name and naming mode, shared by every table that has that column. */
const updatedAtFunctions = new Map<string, PgFunctionDefinition>();

const updatedAtFunctionName = (column: string) => `drizzle_triggers_set_${column}`;

/**
 * The trigger function that sets `column` to `now()`, named after the column's name in the database, such as
 * `drizzle_triggers_set_updated_at`. Tables whose column has the same name share it.
 * It assigns the column directly, which is the fastest a trigger can do it.
 *
 * On Drizzle 0.x a key-named column gets its database name from `casing`, so `name` is the name without
 * casing; the generated SQL uses the name with it.
 */
export function updatedAtFunction(column: PgColumn): PgFunctionDefinition {
	const key = `${column.keyAsName ? 'key' : 'name'}:${column.name}`;
	const cached = updatedAtFunctions.get(key);
	if (cached !== undefined) {
		return cached;
	}

	const definition = pgFunction(updatedAtFunctionName(column.name), {
		returns: 'trigger',
		body: '',
		[forCasing](casing) {
			const name = columnName(column, casing);
			const functionName = updatedAtFunctionName(name);
			assertIdentifier(functionName, `updatedAtFunction(${name})`);
			return {name: functionName, body: `BEGIN\n\tNEW.${quoteIdentifier(name)} := now();\n\tRETURN NEW;\nEND;`};
		},
	});
	updatedAtFunctions.set(key, definition);
	return definition;
}

export type UpdatedAtOptions = {
	/** Defaults to `<table>_set_<column>`, such as `posts_set_updated_at`. */
	readonly name?: string;
};

/**
 * Sets `column` to `now()` on every update, also for updates that do not go through Drizzle,
 * which `$onUpdate()` cannot do. Inserts are left alone, so give the column a `.defaultNow()` too.
 * The trigger function comes with it, so exporting the trigger is all it takes.
 *
 * @example
 * export const postsUpdatedAt = updatedAtTrigger(posts, posts.updatedAt);
 */
export function updatedAtTrigger<TTable extends PgTable>(table: TTable, column: PgColumn, options: UpdatedAtOptions = {}): PgTriggerDefinition<TTable> {
	const tableName = getTableConfig(table).name;
	if (column.table !== table) {
		throw new TypeError(`updatedAtTrigger(${tableName}): the column ${column.name} belongs to another table`);
	}

	const type = column.getSQLType();
	if (!type.startsWith('timestamp') && type !== 'date') {
		throw new TypeError(`updatedAtTrigger(${tableName}): ${column.name} is ${type}, but now() needs a timestamp, timestamptz or date column`);
	}

	return pgTrigger(options.name ?? `${tableName}_set_${toSnakeCase(column.name)}`, {
		table,
		timing: 'before',
		events: ['update'],
		function: updatedAtFunction(column),
	});
}
