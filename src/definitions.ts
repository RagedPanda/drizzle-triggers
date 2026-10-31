import {is} from 'drizzle-orm';
import {PgTable, type PgColumn} from 'drizzle-orm/pg-core';
import type {Casing, RowReferences} from './columns.ts';
import {assertIdentifier, assertName, assertOptions} from './identifiers.ts';
import type {SqlText} from './sql-text.ts';

// Registered symbols, so definitions still match when a schema file loads a second copy of this package.
const functionBrand = Symbol.for('drizzle-triggers.function');
const triggerBrand = Symbol.for('drizzle-triggers.trigger');

/** Lets a recipe render its body for the project's `casing`, which is only known when rendering. Internal. */
export const forCasing: unique symbol = Symbol.for('drizzle-triggers.for-casing') as never;

export type Volatility = 'volatile' | 'stable' | 'immutable';

export type FunctionArgument = {
	/** Optional for SQL functions, which can refer to arguments as `$1`, `$2`. */
	readonly name?: string;
	/** A Postgres type, such as `integer`, `text[]` or `"app"."status"`. */
	readonly type: string;
	/** A SQL expression, such as `0` or `'pending'`. */
	readonly default?: string;
};

export type FunctionOptions = {
	/** Defaults to none, so the function is created in the first schema of the `search_path` (usually `public`). */
	readonly schema?: string;
	readonly args?: readonly FunctionArgument[];
	/** The return type, such as `trigger`, `void`, `integer` or `setof "users"`. */
	readonly returns: string;
	/** Defaults to `plpgsql`. */
	readonly language?: string;
	/** The function body, without the surrounding dollar quotes. */
	readonly body: SqlText;
	/** Defaults to `volatile`, like in Postgres. */
	readonly volatility?: Volatility;
	/** `STRICT`: the function returns null without running when any argument is null. */
	readonly strict?: boolean;
	/** Defaults to `invoker`. */
	readonly security?: 'invoker' | 'definer';
	/** Pins the `search_path` while the function runs, which `security: 'definer'` functions should always do. `[]` sets it to empty. */
	readonly searchPath?: readonly string[];
	readonly parallel?: 'unsafe' | 'restricted' | 'safe';
	readonly leakproof?: boolean;
	/** @internal Gives the name and body for a casing, for recipes named after a column whose name depends on it. */
	readonly [forCasing]?: (casing: Casing | undefined) => {readonly name: string; readonly body: string};
};

export type PgFunctionDefinition = FunctionOptions & {
	readonly name: string;
	readonly [functionBrand]: true;
};

export type TriggerTiming = 'before' | 'after' | 'instead of';
export type TriggerEvent = 'insert' | 'update' | 'delete' | 'truncate';

/** A table, view or function that is not defined with Drizzle, by name. */
export type NamedReference = {
	readonly name: string;
	readonly schema?: string;
};

export type TriggerRows<TTable extends PgTable> = {
	readonly NEW: RowReferences<TTable>;
	readonly OLD: RowReferences<TTable>;
};

/**
 * Written as a method so its parameter is checked bivariantly: a trigger on a specific table
 * still fits wherever any trigger is accepted, such as `applyDefinitions([trigger])`.
 */
type WhenCallback<TTable extends PgTable> = {
	bivariant(rows: TriggerRows<TTable>): SqlText;
}['bivariant'];

export type TriggerOptions<TTable extends PgTable = PgTable> = {
	/** A Drizzle table, or a `{name, schema}` reference for a view or any other relation. */
	readonly table: TTable | NamedReference;
	readonly timing: TriggerTiming;
	readonly events: readonly TriggerEvent[];
	/** `UPDATE OF ...`: fire on updates only when one of these columns is in the `SET` list. */
	readonly columns?: readonly (PgColumn | string)[];
	/** Defaults to `row`. */
	readonly forEach?: 'row' | 'statement';
	/** The `WHEN` condition. Use the callback form to refer to `NEW` and `OLD` columns by their Drizzle keys. */
	readonly when?: SqlText | WhenCallback<TTable>;
	/** Transition tables for `after` triggers: `REFERENCING NEW TABLE AS ... OLD TABLE AS ...`. */
	readonly referencing?: {
		readonly newTable?: string;
		readonly oldTable?: string;
	};
	/** A function from `pgFunction()`, or a `{name, schema}` reference to one that already exists. */
	readonly function: PgFunctionDefinition | NamedReference;
	/** Arguments for the function, available in it as `TG_ARGV` text. A column is passed as its database name. */
	readonly args?: readonly (string | number | PgColumn)[];
};

export type PgTriggerDefinition<TTable extends PgTable = PgTable> = TriggerOptions<TTable> & {
	readonly name: string;
	readonly [triggerBrand]: true;
};

export type Definition = PgFunctionDefinition | PgTriggerDefinition;

const volatilities = new Set(['volatile', 'stable', 'immutable']);
const securities = new Set(['invoker', 'definer']);
const parallelModes = new Set(['unsafe', 'restricted', 'safe']);
const timings = new Set(['before', 'after', 'instead of']);
const events = new Set(['insert', 'update', 'delete', 'truncate']);
const rowModes = new Set(['row', 'statement']);

function assertOneOf(value: unknown, allowed: ReadonlySet<string>, label: string, required = false): void {
	if ((required || value !== undefined) && !allowed.has(value as string)) {
		throw new TypeError(`${label} must be one of ${[...allowed].join(', ')}, got ${JSON.stringify(value)}`);
	}
}

function validateFunction(name: string, options: FunctionOptions): void {
	const label = `pgFunction('${name}')`;
	assertIdentifier(name, 'pgFunction name');
	assertOptions(options, label);
	if (options.schema !== undefined) {
		assertIdentifier(options.schema, `${label} schema`);
	}

	assertName(options.returns, `${label} returns`);
	for (const [index, argument] of (options.args ?? []).entries()) {
		assertName(argument.type, `${label} args[${index}].type`);
	}

	if (typeof options.body !== 'string' && typeof options.body?.inlineParams !== 'function') {
		throw new TypeError(`${label} body must be a string or a sql\`\` template`);
	}

	assertOneOf(options.volatility, volatilities, `${label} volatility`);
	assertOneOf(options.security, securities, `${label} security`);
	assertOneOf(options.parallel, parallelModes, `${label} parallel`);
}

/**
 * Defines a Postgres function. Export it from a schema file, or use it in a trigger,
 * and `drizzle-triggers generate` writes the migration that creates it.
 *
 * @example
 * export const setUpdatedAt = pgFunction('set_updated_at', {
 * 	returns: 'trigger',
 * 	body: 'BEGIN NEW.updated_at := now(); RETURN NEW; END;',
 * });
 */
export function pgFunction(name: string, options: FunctionOptions): PgFunctionDefinition {
	validateFunction(name, options);
	return Object.freeze({
		...options,
		...(options.args && {args: Object.freeze(options.args.map(argument => Object.freeze({...argument})))}),
		...(options.searchPath && {searchPath: Object.freeze([...options.searchPath])}),
		name,
		[functionBrand]: true as const,
	});
}

function isTable(value: unknown): value is PgTable {
	return is(value, PgTable);
}

function validateTrigger(name: string, options: TriggerOptions<PgTable>): void {
	const label = `pgTrigger('${name}')`;
	assertIdentifier(name, 'pgTrigger name');
	assertOptions(options, label);
	if (!isTable(options.table)) {
		assertName(options.table?.name, `${label} table name`);
	}

	assertOneOf(options.timing, timings, `${label} timing`, true);
	assertOneOf(options.forEach, rowModes, `${label} forEach`);
	if (!Array.isArray(options.events) || options.events.length === 0) {
		throw new TypeError(`${label} events must list at least one of insert, update, delete, truncate`);
	}

	for (const event of options.events) {
		assertOneOf(event, events, `${label} events`);
	}

	if (options.columns !== undefined && !options.events.includes('update')) {
		throw new TypeError(`${label} columns only apply to the update event`);
	}

	const forEach = options.forEach ?? 'row';
	if (options.timing === 'instead of' && forEach !== 'row') {
		throw new TypeError(`${label} instead of triggers must be forEach: 'row'`);
	}

	if (options.events.includes('truncate') && forEach !== 'statement') {
		throw new TypeError(`${label} truncate triggers must be forEach: 'statement'`);
	}

	if (typeof options.when === 'function' && !isTable(options.table)) {
		throw new TypeError(`${label} the when callback needs a Drizzle table; pass the condition as sql\`\` instead`);
	}

	const target = options.function;
	if (isFunctionDefinition(target)) {
		if (target.returns.trim().toLowerCase() !== 'trigger' || (target.args?.length ?? 0) > 0) {
			throw new TypeError(`${label} function ${target.name} must take no arguments and return trigger; pass values with the trigger's args instead`);
		}
	} else {
		assertName(target?.name, `${label} function name`);
	}
}

/**
 * Defines a Postgres trigger on a table.
 *
 * @example
 * export const postsUpdatedAt = pgTrigger('posts_updated_at', {
 * 	table: posts,
 * 	timing: 'before',
 * 	events: ['update'],
 * 	function: setUpdatedAt,
 * });
 */
export function pgTrigger<TTable extends PgTable>(name: string, options: TriggerOptions<TTable>): PgTriggerDefinition<TTable> {
	validateTrigger(name, options as unknown as TriggerOptions<PgTable>);
	return Object.freeze({
		...options,
		events: Object.freeze([...options.events]),
		...(options.columns && {columns: Object.freeze([...options.columns])}),
		...(options.args && {args: Object.freeze([...options.args])}),
		...(options.referencing && {referencing: Object.freeze({...options.referencing})}),
		name,
		[triggerBrand]: true as const,
	});
}

export function isFunctionDefinition(value: unknown): value is PgFunctionDefinition {
	return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[functionBrand] === true;
}

export function isTriggerDefinition(value: unknown): value is PgTriggerDefinition {
	return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[triggerBrand] === true;
}

export {isTable};
