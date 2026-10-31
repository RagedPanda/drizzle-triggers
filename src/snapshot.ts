import {createHash} from 'node:crypto';
import {effectiveCasing, type Casing} from './columns.ts';
import {isFunctionDefinition, type Definition, type PgFunctionDefinition, type PgTriggerDefinition} from './definitions.ts';
import {
	createFunctionSql, createTriggerSql, dropFunctionSql, dropTriggerSql,
	functionIdentity, functionSignature, triggerFunctionIdentity, triggerIdentity,
} from './render.ts';

export type FunctionState = {
	readonly drop: string;
	readonly hash: string;
	readonly signature: string;
};

export type TriggerState = {
	readonly drop: string;
	readonly hash: string;
	/** The identity of the function the trigger runs. */
	readonly function: string;
};

/** What the database looks like after a migration, saved in the migration so the next one can diff against it. */
export type State = {
	readonly version: 1;
	readonly functions: Readonly<Record<string, FunctionState>>;
	readonly triggers: Readonly<Record<string, TriggerState>>;
};

export type Snapshot = {
	readonly functions: ReadonlyMap<string, FunctionState & {readonly create: string}>;
	readonly triggers: ReadonlyMap<string, TriggerState & {readonly create: string}>;
};

export const emptyState: State = Object.freeze({version: 1, functions: Object.freeze({}), triggers: Object.freeze({})});

function hashOf(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Adds `entry` under `identity`, unless the same definition is already there; two different ones are an error. */
function addUnique<Entry extends {readonly create: string}>(entries: Map<string, Entry>, identity: string, entry: Entry, kind: string): void {
	const existing = entries.get(identity);
	if (existing !== undefined && existing.create !== entry.create) {
		throw new Error(`Two different ${kind} definitions are named ${identity}; rename one of them`);
	}

	entries.set(identity, entry);
}

function functionEntry(definition: PgFunctionDefinition, casing: Casing | undefined) {
	const create = createFunctionSql(definition, casing);
	return {create, drop: dropFunctionSql(definition, casing), hash: hashOf(create), signature: functionSignature(definition)};
}

function triggerEntry(definition: PgTriggerDefinition, casing: Casing | undefined) {
	const create = createTriggerSql(definition, casing);
	return {create, drop: dropTriggerSql(definition), hash: hashOf(create), function: triggerFunctionIdentity(definition, casing)};
}

/**
 * Renders every definition. A function used by a trigger is included even when it is not exported itself,
 * and each function comes before the triggers that run it. `casing` is ignored on Drizzle 1.0, which
 * applies it in the table builder instead.
 */
export function buildSnapshot(definitions: Iterable<Definition>, requestedCasing: Casing | undefined): Snapshot {
	const casing = effectiveCasing(requestedCasing);
	const functions = new Map<string, FunctionState & {readonly create: string}>();
	const triggers = new Map<string, TriggerState & {readonly create: string}>();
	// Many triggers share one function object, such as every updatedAtTrigger() for the same column name; render it once.
	const renderedFunctions = new Set<PgFunctionDefinition>();
	const addFunction = (definition: PgFunctionDefinition) => {
		if (!renderedFunctions.has(definition)) {
			renderedFunctions.add(definition);
			addUnique(functions, functionIdentity(definition, casing), functionEntry(definition, casing), 'function');
		}
	};

	for (const definition of definitions) {
		if (isFunctionDefinition(definition)) {
			addFunction(definition);
			continue;
		}

		if (isFunctionDefinition(definition.function)) {
			addFunction(definition.function);
		}

		addUnique(triggers, triggerIdentity(definition), triggerEntry(definition, casing), 'trigger');
	}

	return {functions, triggers};
}

/** The snapshot without the `CREATE` statements, which is all the next diff needs. */
export function toState(snapshot: Snapshot): State {
	const strip = <Entry extends {readonly create: string}>(entries: ReadonlyMap<string, Entry>) =>
		Object.fromEntries([...entries].map(([identity, {create, ...rest}]) => [identity, rest]));
	return {
		version: 1,
		functions: strip(snapshot.functions) as Record<string, FunctionState>,
		triggers: strip(snapshot.triggers) as Record<string, TriggerState>,
	};
}

/**
 * The statements that take a database from `previous` to `next`, in an order Postgres accepts:
 * drop triggers, drop functions, create or replace functions, create triggers.
 *
 * A function whose return type, argument names or defaults changed is dropped and created again,
 * and so are the triggers that run it. A changed trigger is dropped and created again.
 */
export function diff(previous: State, next: Snapshot): string[] {
	const previousFunctions = Object.entries(previous.functions);
	const previousTriggers = Object.entries(previous.triggers);
	const droppedFunctions = new Set(previousFunctions
		.filter(([identity, state]) => next.functions.get(identity)?.signature !== state.signature)
		.map(([identity]) => identity));
	const droppedTriggers = new Set(previousTriggers
		.filter(([identity, state]) => next.triggers.get(identity)?.hash !== state.hash || droppedFunctions.has(state.function))
		.map(([identity]) => identity));

	return [
		...previousTriggers.filter(([identity]) => droppedTriggers.has(identity)).map(([, state]) => state.drop),
		...previousFunctions.filter(([identity]) => droppedFunctions.has(identity)).map(([, state]) => state.drop),
		...[...next.functions]
			.filter(([identity, entry]) => previous.functions[identity]?.hash !== entry.hash || droppedFunctions.has(identity))
			.map(([, entry]) => entry.create),
		...[...next.triggers]
			.filter(([identity]) => previous.triggers[identity] === undefined || droppedTriggers.has(identity))
			.map(([, entry]) => entry.create),
	];
}

/**
 * Statements that bring any database up to `next` and can run again safely: every function is created
 * or replaced and every trigger dropped if it exists and created again. Objects that are no longer
 * defined are left alone, and a function whose return type changed has to be dropped by hand first.
 */
export function idempotentStatements(next: Snapshot): string[] {
	return [
		...[...next.triggers.values()].map(entry => entry.drop),
		...[...next.functions.values()].map(entry => entry.create),
		...[...next.triggers.values()].map(entry => entry.create),
	];
}
