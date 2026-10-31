import {getTableConfig} from 'drizzle-orm/pg-core';
import {columnName, rowReferences, type Casing} from './columns.ts';
import {forCasing, isFunctionDefinition, isTable, type NamedReference, type PgFunctionDefinition, type PgTriggerDefinition, type TriggerEvent} from './definitions.ts';
import {dollarQuote, qualifiedName, quoteIdentifier, quoteLiteral} from './identifiers.ts';
import {renderSqlText} from './sql-text.ts';

const defaultSchema = 'public';
const eventOrder: readonly TriggerEvent[] = ['insert', 'update', 'delete', 'truncate'];

/** `integer`, `INTEGER` and `integer ` are the same type; compare them as one. */
function normalizeType(type: string): string {
	return type.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function argumentTypes(definition: PgFunctionDefinition): string[] {
	return (definition.args ?? []).map(argument => normalizeType(argument.type));
}

/** The function's name in the database, which for a recipe can depend on `casing`. */
function functionName(definition: PgFunctionDefinition, casing: Casing | undefined): string {
	return definition[forCasing]?.(casing).name ?? definition.name;
}

/** What Postgres identifies a function by: its schema, name and argument types, such as `public.add(integer,integer)`. */
export function functionIdentity(definition: PgFunctionDefinition, casing: Casing | undefined): string {
	return `${definition.schema ?? defaultSchema}.${functionName(definition, casing)}(${argumentTypes(definition).join(',')})`;
}

/**
 * The parts of a function that `CREATE OR REPLACE` cannot change: the return type, argument names and defaults.
 * When it changes, the function has to be dropped and created again.
 */
export function functionSignature(definition: PgFunctionDefinition): string {
	return JSON.stringify({
		returns: normalizeType(definition.returns),
		args: (definition.args ?? []).map(argument => [argument.name ?? null, argument.default ?? null]),
	});
}

function renderArgument(argument: NonNullable<PgFunctionDefinition['args']>[number]): string {
	const name = argument.name === undefined ? '' : `${quoteIdentifier(argument.name)} `;
	const fallback = argument.default === undefined ? '' : ` DEFAULT ${argument.default}`;
	return `${name}${argument.type}${fallback}`;
}

function functionAttributes(definition: PgFunctionDefinition): string[] {
	const attributes = [
		`LANGUAGE ${definition.language ?? 'plpgsql'}`,
		(definition.volatility ?? 'volatile').toUpperCase(),
	];
	if (definition.strict === true) {
		attributes.push('STRICT');
	}

	if (definition.security === 'definer') {
		attributes.push('SECURITY DEFINER');
	}

	if (definition.leakproof === true) {
		attributes.push('LEAKPROOF');
	}

	if (definition.parallel !== undefined) {
		attributes.push(`PARALLEL ${definition.parallel.toUpperCase()}`);
	}

	if (definition.searchPath !== undefined) {
		const path = definition.searchPath.length === 0 ? '\'\'' : definition.searchPath.map(quoteIdentifier).join(', ');
		attributes.push(`SET search_path = ${path}`);
	}

	return attributes;
}

export function createFunctionSql(definition: PgFunctionDefinition, casing: Casing | undefined): string {
	const args = (definition.args ?? []).map(renderArgument).join(', ');
	return [
		`CREATE OR REPLACE FUNCTION ${qualifiedName(functionName(definition, casing), definition.schema)}(${args})`,
		`RETURNS ${definition.returns}`,
		...functionAttributes(definition),
		`AS ${dollarQuote((definition[forCasing]?.(casing).body ?? renderSqlText(definition.body, casing)).trim())};`,
	].join('\n');
}

export function dropFunctionSql(definition: PgFunctionDefinition, casing: Casing | undefined): string {
	return `DROP FUNCTION IF EXISTS ${qualifiedName(functionName(definition, casing), definition.schema)}(${argumentTypes(definition).join(', ')});`;
}

function triggerTable(definition: PgTriggerDefinition): NamedReference {
	if (!isTable(definition.table)) {
		return definition.table;
	}

	const {name, schema} = getTableConfig(definition.table);
	return schema === undefined ? {name} : {name, schema};
}

function referenceName(reference: NamedReference): string {
	return qualifiedName(reference.name, reference.schema);
}

/** What Postgres identifies a trigger by: its table and name, such as `public.posts.posts_updated_at`. */
export function triggerIdentity(definition: PgTriggerDefinition): string {
	const table = triggerTable(definition);
	return `${table.schema ?? defaultSchema}.${table.name}.${definition.name}`;
}

/** The identity of the function a trigger runs, which matches `functionIdentity()` when it is defined here too. */
export function triggerFunctionIdentity(definition: PgTriggerDefinition, casing: Casing | undefined): string {
	const target = definition.function;
	return isFunctionDefinition(target) ? functionIdentity(target, casing) : `${target.schema ?? defaultSchema}.${target.name}()`;
}

function renderEvents(definition: PgTriggerDefinition, casing: Casing | undefined): string {
	const columns = (definition.columns ?? []).map(column => quoteIdentifier(typeof column === 'string' ? column : columnName(column, casing)));
	return eventOrder
		.filter(event => definition.events.includes(event))
		.map(event => (event === 'update' && columns.length > 0 ? `UPDATE OF ${columns.join(', ')}` : event.toUpperCase()))
		.join(' OR ');
}

function renderCondition(definition: PgTriggerDefinition, casing: Casing | undefined): string {
	const {when, table} = definition;
	if (typeof when !== 'function') {
		return renderSqlText(when!, casing);
	}

	// The callback form is only accepted with a Drizzle table, which pgTrigger() checks.
	const rowTable = table as Parameters<typeof rowReferences>[0];
	return renderSqlText(when({NEW: rowReferences(rowTable, 'NEW', casing), OLD: rowReferences(rowTable, 'OLD', casing)}), casing);
}

function renderReferencing(referencing: NonNullable<PgTriggerDefinition['referencing']>): string {
	const parts = [];
	if (referencing.newTable !== undefined) {
		parts.push(`NEW TABLE AS ${quoteIdentifier(referencing.newTable)}`);
	}

	if (referencing.oldTable !== undefined) {
		parts.push(`OLD TABLE AS ${quoteIdentifier(referencing.oldTable)}`);
	}

	return `REFERENCING ${parts.join(' ')}`;
}

export function createTriggerSql(definition: PgTriggerDefinition, casing: Casing | undefined): string {
	const lines = [
		`CREATE TRIGGER ${quoteIdentifier(definition.name)}`,
		`${definition.timing.toUpperCase()} ${renderEvents(definition, casing)} ON ${referenceName(triggerTable(definition))}`,
	];
	if (definition.referencing !== undefined) {
		lines.push(renderReferencing(definition.referencing));
	}

	lines.push(`FOR EACH ${(definition.forEach ?? 'row').toUpperCase()}`);
	if (definition.when !== undefined) {
		lines.push(`WHEN (${renderCondition(definition, casing)})`);
	}

	const args = (definition.args ?? [])
		.map(argument => quoteLiteral(typeof argument === 'object' ? columnName(argument, casing) : String(argument)))
		.join(', ');
	const target = definition.function;
	const targetName = isFunctionDefinition(target) ? qualifiedName(functionName(target, casing), target.schema) : referenceName(target);
	lines.push(`EXECUTE FUNCTION ${targetName}(${args});`);
	return lines.join('\n');
}

export function dropTriggerSql(definition: PgTriggerDefinition): string {
	return `DROP TRIGGER IF EXISTS ${quoteIdentifier(definition.name)} ON ${referenceName(triggerTable(definition))};`;
}
