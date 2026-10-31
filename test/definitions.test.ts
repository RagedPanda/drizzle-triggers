import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {isFunctionDefinition, isTriggerDefinition, pgFunction, pgTrigger, type TriggerOptions} from '../src/definitions.ts';
import {posts, users} from './fixtures.ts';

const touch = pgFunction('touch', {returns: 'trigger', body: 'BEGIN RETURN NEW; END;'});
const baseTrigger: TriggerOptions = {table: users, timing: 'before', events: ['update'], function: touch};

test('pgFunction returns a frozen, branded definition', () => {
	assert.equal(touch.name, 'touch');
	assert.equal(touch.returns, 'trigger');
	assert.ok(Object.isFrozen(touch));
	assert.ok(isFunctionDefinition(touch));
	assert.ok(!isTriggerDefinition(touch));
	assert.ok(!isFunctionDefinition({name: 'touch'}));
	assert.ok(!isFunctionDefinition(null));
	assert.ok(!isFunctionDefinition('touch'));
});

test('pgFunction accepts a sql`` body', () => {
	assert.ok(isFunctionDefinition(pgFunction('count_posts', {returns: 'bigint', language: 'sql', body: sql`SELECT count(*) FROM ${posts}`})));
});

test('pgFunction rejects invalid options', () => {
	const cases: [string, Parameters<typeof pgFunction>[1], RegExp][] = [
		['', {returns: 'void', body: ''}, /pgFunction name must be/],
		['f', {returns: '', body: ''}, /returns must be/],
		['f', undefined as unknown as {returns: string; body: string}, /pgFunction\('f'\) needs an options object/],
		['f'.repeat(64), {returns: 'void', body: ''}, /pgFunction name must be at most 63 bytes/],
		['é'.repeat(32), {returns: 'void', body: ''}, /at most 63 bytes/],
		['f', {schema: '', returns: 'void', body: ''}, /schema must be/],
		['f', {returns: 'void', body: '', args: [{type: ''}]}, /args\[0\]\.type must be/],
		['f', {returns: 'void', body: 3 as unknown as string}, /body must be a string or a sql/],
		['f', {returns: 'void', body: undefined as unknown as string}, /body must be a string or a sql/],
		['f', {returns: 'void', body: '', volatility: 'fast' as 'stable'}, /volatility must be one of volatile, stable, immutable/],
		['f', {returns: 'void', body: '', security: 'root' as 'definer'}, /security must be one of/],
		['f', {returns: 'void', body: '', parallel: 'yes' as 'safe'}, /parallel must be one of/],
	];
	for (const [name, options, message] of cases) {
		assert.throws(() => pgFunction(name, options), {name: 'TypeError', message}, String(message));
	}
});

test('pgTrigger returns a frozen, branded definition', () => {
	const trigger = pgTrigger('users_touch', baseTrigger);
	assert.equal(trigger.name, 'users_touch');
	assert.ok(Object.isFrozen(trigger));
	assert.ok(isTriggerDefinition(trigger));
	assert.ok(!isFunctionDefinition(trigger));
});

test('pgTrigger accepts named references for the table and the function', () => {
	const trigger = pgTrigger('view_insert', {
		table: {schema: 'app', name: 'post_view'},
		timing: 'instead of',
		events: ['insert'],
		function: {name: 'insert_post'},
		when: 'true',
	});
	assert.ok(isTriggerDefinition(trigger));
});

test('definitions keep their own copies of arrays, so later changes to the options do not leak in', () => {
	const args = [{name: 'a', type: 'int'}];
	const searchPath = ['public'];
	const add = pgFunction('add', {args, searchPath, returns: 'int', body: ''});
	args[0]!.type = 'text';
	args.push({name: 'b', type: 'int'});
	searchPath.push('app');
	assert.deepEqual(add.args, [{name: 'a', type: 'int'}]);
	assert.deepEqual(add.searchPath, ['public']);
	assert.ok(Object.isFrozen(add.args) && Object.isFrozen(add.args![0]) && Object.isFrozen(add.searchPath));

	const events: ('insert' | 'update')[] = ['update'];
	const columns: (typeof users.name | typeof users.id | string)[] = [users.name];
	const triggerArgs = ['x'];
	const referencing = {newTable: 'n'};
	const trigger = pgTrigger('t', {...baseTrigger, timing: 'after', events, columns, args: triggerArgs, referencing});
	events.push('insert');
	columns.push(users.id);
	triggerArgs.push('y');
	referencing.newTable = 'changed';
	assert.deepEqual(trigger.events, ['update']);
	assert.deepEqual(trigger.columns, [users.name]);
	assert.deepEqual(trigger.args, ['x']);
	assert.deepEqual(trigger.referencing, {newTable: 'n'});
	assert.ok(Object.isFrozen(trigger.events) && Object.isFrozen(trigger.columns) && Object.isFrozen(trigger.args) && Object.isFrozen(trigger.referencing));
	assert.equal(pgFunction('f', {returns: 'void', body: ''}).args, undefined);
});

test('pgTrigger needs an options object', () => {
	assert.throws(() => pgTrigger('t', undefined as unknown as TriggerOptions), /pgTrigger\('t'\) needs an options object/);
});

test('pgTrigger rejects invalid options', () => {
	const cases: [string, Partial<TriggerOptions>, RegExp][] = [
		['', {}, /pgTrigger name must be/],
		['t', {table: {name: ''}}, /table name must be/],
		['t', {timing: 'during' as 'before'}, /timing must be one of before, after, instead of/],
		['t', {timing: undefined as unknown as 'before'}, /timing must be one of before, after, instead of, got undefined/],
		['t'.repeat(64), {}, /pgTrigger name must be at most 63 bytes/],
		['t', {forEach: 'column' as 'row'}, /forEach must be one of row, statement/],
		['t', {events: []}, /events must list at least one/],
		['t', {events: 'update' as unknown as ['update']}, /events must list at least one/],
		['t', {events: ['upsert' as 'update']}, /events must be one of insert, update, delete, truncate/],
		['t', {events: ['insert'], columns: [users.name]}, /columns only apply to the update event/],
		['t', {timing: 'instead of', forEach: 'statement'}, /instead of triggers must be forEach: 'row'/],
		['t', {events: ['truncate']}, /truncate triggers must be forEach: 'statement'/],
		['t', {table: {name: 'view'}, when: () => 'true'}, /the when callback needs a Drizzle table/],
		['t', {function: pgFunction('add', {returns: 'integer', body: ''})}, /function add must take no arguments and return trigger/],
		['t', {function: pgFunction('add', {returns: 'trigger', args: [{type: 'int'}], body: ''})}, /must take no arguments/],
		['t', {function: {name: ''}}, /function name must be/],
	];
	for (const [name, overrides, message] of cases) {
		assert.throws(() => pgTrigger(name, {...baseTrigger, ...overrides}), {name: 'TypeError', message}, String(message));
	}
});
