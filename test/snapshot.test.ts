import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pgFunction, pgTrigger, type FunctionOptions} from '../src/definitions.ts';
import {buildSnapshot, diff, emptyState, idempotentStatements, toState} from '../src/snapshot.ts';
import {posts, users} from './fixtures.ts';

const touchOptions: FunctionOptions = {returns: 'trigger', body: 'BEGIN RETURN NEW; END;'};
const touch = pgFunction('touch', touchOptions);
const usersTouch = pgTrigger('users_touch', {table: users, timing: 'before', events: ['update'], function: touch});
const postsTouch = pgTrigger('posts_touch', {table: posts, timing: 'before', events: ['update'], function: touch});
const add = pgFunction('add', {args: [{name: 'a', type: 'int'}], returns: 'int', language: 'sql', body: 'SELECT a + 1'});

/** The first line of each statement, which is enough to tell them apart. */
function heads(statements: readonly string[]): string[] {
	return statements.map(statement => statement.split('\n')[0]!);
}

test('buildSnapshot includes functions used by triggers, before the triggers', () => {
	const snapshot = buildSnapshot([usersTouch, add], undefined);
	assert.deepEqual([...snapshot.functions.keys()], ['public.touch()', 'public.add(int)']);
	assert.deepEqual([...snapshot.triggers.keys()], ['public.users.users_touch']);
	assert.equal(snapshot.triggers.get('public.users.users_touch')?.function, 'public.touch()');
	assert.match(snapshot.functions.get('public.touch()')!.hash, /^[0-9a-f]{16}$/);
});

test('buildSnapshot accepts the same definition twice and rejects two different ones with one name', () => {
	assert.equal(buildSnapshot([touch, usersTouch, pgFunction('touch', touchOptions)], undefined).functions.size, 1);
	assert.throws(() => buildSnapshot([touch, pgFunction('touch', {...touchOptions, body: 'other'})], undefined), /Two different function definitions are named public.touch\(\)/);
	const other = pgTrigger('users_touch', {table: users, timing: 'after', events: ['update'], function: touch});
	assert.throws(() => buildSnapshot([usersTouch, other], undefined), /Two different trigger definitions are named public.users.users_touch/);
});

test('diff from nothing creates every function, then every trigger', () => {
	assert.deepEqual(heads(diff(emptyState, buildSnapshot([usersTouch, add, postsTouch], undefined))), [
		'CREATE OR REPLACE FUNCTION "touch"()',
		'CREATE OR REPLACE FUNCTION "add"("a" int)',
		'CREATE TRIGGER "users_touch"',
		'CREATE TRIGGER "posts_touch"',
	]);
});

test('diff is empty when nothing changed', () => {
	const snapshot = buildSnapshot([usersTouch, add], undefined);
	assert.deepEqual(diff(toState(snapshot), snapshot), []);
});

test('diff replaces a function whose body changed and leaves its triggers alone', () => {
	const previous = toState(buildSnapshot([usersTouch], undefined));
	const changed = pgFunction('touch', {...touchOptions, body: 'BEGIN NEW.name := upper(NEW.name); RETURN NEW; END;'});
	const statements = diff(previous, buildSnapshot([pgTrigger('users_touch', {...usersTouch, function: changed})], undefined));
	assert.deepEqual(heads(statements), ['CREATE OR REPLACE FUNCTION "touch"()']);
});

test('diff drops and recreates a function whose signature changed', () => {
	const previous = toState(buildSnapshot([usersTouch, postsTouch, add], undefined));
	const changed = pgFunction('add', {args: [{name: 'a', type: 'int'}], returns: 'bigint', language: 'sql', body: 'SELECT a + 1'});
	assert.deepEqual(heads(diff(previous, buildSnapshot([usersTouch, postsTouch, changed], undefined))), [
		'DROP FUNCTION IF EXISTS "add"(int);',
		'CREATE OR REPLACE FUNCTION "add"("a" int)',
	]);
});

test('diff recreates the dependent triggers when a trigger function is dropped and created again', () => {
	const touchTriggers = (fn: typeof touch) => [
		pgTrigger('users_touch', {...usersTouch, function: fn}),
		pgTrigger('posts_touch', {...postsTouch, function: fn}),
	];
	const previous = {
		...toState(buildSnapshot(touchTriggers(touch), undefined)),
		functions: {'public.touch()': {drop: 'DROP FUNCTION IF EXISTS "touch"();', hash: 'old', signature: 'old'}},
	};
	assert.deepEqual(heads(diff(previous, buildSnapshot(touchTriggers(touch), undefined))), [
		'DROP TRIGGER IF EXISTS "users_touch" ON "users";',
		'DROP TRIGGER IF EXISTS "posts_touch" ON "app"."posts";',
		'DROP FUNCTION IF EXISTS "touch"();',
		'CREATE OR REPLACE FUNCTION "touch"()',
		'CREATE TRIGGER "users_touch"',
		'CREATE TRIGGER "posts_touch"',
	]);
});

test('diff drops and recreates a changed trigger, and drops removed ones', () => {
	const previous = toState(buildSnapshot([usersTouch, postsTouch, add], undefined));
	const changed = pgTrigger('users_touch', {...usersTouch, events: ['insert', 'update']});
	assert.deepEqual(heads(diff(previous, buildSnapshot([changed], undefined))), [
		'DROP TRIGGER IF EXISTS "users_touch" ON "users";',
		'DROP TRIGGER IF EXISTS "posts_touch" ON "app"."posts";',
		'DROP FUNCTION IF EXISTS "add"(int);',
		'CREATE TRIGGER "users_touch"',
	]);
	assert.deepEqual(heads(diff(previous, buildSnapshot([], undefined))), [
		'DROP TRIGGER IF EXISTS "users_touch" ON "users";',
		'DROP TRIGGER IF EXISTS "posts_touch" ON "app"."posts";',
		'DROP FUNCTION IF EXISTS "touch"();',
		'DROP FUNCTION IF EXISTS "add"(int);',
	]);
});

test('toState keeps everything but the create statements', () => {
	const state = toState(buildSnapshot([usersTouch], undefined));
	assert.deepEqual(Object.keys(state), ['version', 'functions', 'triggers']);
	assert.deepEqual(Object.keys(state.functions['public.touch()']!), ['drop', 'hash', 'signature']);
	assert.deepEqual(Object.keys(state.triggers['public.users.users_touch']!), ['drop', 'hash', 'function']);
});

test('idempotentStatements drops triggers if they exist, then creates everything', () => {
	assert.deepEqual(heads(idempotentStatements(buildSnapshot([usersTouch, add], undefined))), [
		'DROP TRIGGER IF EXISTS "users_touch" ON "users";',
		'CREATE OR REPLACE FUNCTION "touch"()',
		'CREATE OR REPLACE FUNCTION "add"("a" int)',
		'CREATE TRIGGER "users_touch"',
	]);
});
