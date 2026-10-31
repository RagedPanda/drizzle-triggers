import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {integer, pgSchema, text} from 'drizzle-orm/pg-core';
import {pgFunction, pgTrigger} from '../src/definitions.ts';
import {
	createFunctionSql, createTriggerSql, dropFunctionSql, dropTriggerSql,
	functionIdentity, functionSignature, triggerFunctionIdentity, triggerIdentity,
} from '../src/render.ts';
import {posts, users} from './fixtures.ts';

// Key-named columns that the `casing` argument renames, on every Drizzle version.
const auditedPosts = pgSchema('app').table('posts', {status: text(), title: text(), commentCount: integer()});

const touch = pgFunction('touch', {returns: 'trigger', body: '\n  BEGIN RETURN NEW; END;\n'});

test('createFunctionSql renders the defaults', () => {
	assert.equal(createFunctionSql(touch, undefined), [
		'CREATE OR REPLACE FUNCTION "touch"()',
		'RETURNS trigger',
		'LANGUAGE plpgsql',
		'VOLATILE',
		'AS $body$',
		'BEGIN RETURN NEW; END;',
		'$body$;',
	].join('\n'));
});

test('createFunctionSql renders every option', () => {
	const add = pgFunction('add', {
		schema: 'app',
		args: [{name: 'a', type: 'integer'}, {name: 'b', type: 'integer', default: '1'}, {type: 'text'}],
		returns: 'integer',
		language: 'sql',
		body: 'SELECT a + b',
		volatility: 'immutable',
		strict: true,
		security: 'definer',
		leakproof: true,
		parallel: 'safe',
		searchPath: ['pg_catalog', 'app'],
	});
	assert.equal(createFunctionSql(add, undefined), [
		'CREATE OR REPLACE FUNCTION "app"."add"("a" integer, "b" integer DEFAULT 1, text)',
		'RETURNS integer',
		'LANGUAGE sql',
		'IMMUTABLE',
		'STRICT',
		'SECURITY DEFINER',
		'LEAKPROOF',
		'PARALLEL SAFE',
		'SET search_path = "pg_catalog", "app"',
		'AS $body$',
		'SELECT a + b',
		'$body$;',
	].join('\n'));
	assert.match(createFunctionSql(pgFunction('f', {returns: 'void', body: '', searchPath: []}), undefined), /SET search_path = ''\n/);
	assert.doesNotMatch(createFunctionSql(pgFunction('f', {returns: 'void', body: '', strict: false, security: 'invoker'}), undefined), /STRICT|SECURITY/);
});

test('createFunctionSql renders a sql`` body with tables and inlined values', () => {
	const count = pgFunction('published_posts', {
		returns: 'bigint',
		language: 'sql',
		body: sql`SELECT count(*) FROM ${posts} WHERE ${sql.identifier('status')} = ${'published'}`,
	});
	assert.match(createFunctionSql(count, undefined), /\nSELECT count\(\*\) FROM "app"."posts" WHERE "status" = 'published'\n/);
});

test('dropFunctionSql and functionIdentity use the argument types', () => {
	const add = pgFunction('add', {args: [{name: 'a', type: ' INTEGER '}, {type: 'double  precision'}], returns: 'integer', body: ''});
	assert.equal(dropFunctionSql(add, undefined), 'DROP FUNCTION IF EXISTS "add"(integer, double precision);');
	assert.equal(functionIdentity(add, undefined), 'public.add(integer,double precision)');
	assert.equal(functionIdentity(pgFunction('f', {schema: 'app', returns: 'void', body: ''}), undefined), 'app.f()');
});

test('functionSignature changes with the return type, argument names and defaults only', () => {
	const base = {args: [{name: 'a', type: 'int'}], returns: 'int', body: 'one'};
	const signature = functionSignature(pgFunction('f', base));
	assert.equal(functionSignature(pgFunction('f', {...base, body: 'two', volatility: 'stable'})), signature);
	assert.equal(functionSignature(pgFunction('f', {...base, returns: ' INT '})), signature);
	assert.notEqual(functionSignature(pgFunction('f', {...base, returns: 'bigint'})), signature);
	assert.notEqual(functionSignature(pgFunction('f', {...base, args: [{name: 'b', type: 'int'}]})), signature);
	assert.notEqual(functionSignature(pgFunction('f', {...base, args: [{name: 'a', type: 'int', default: '0'}]})), signature);
	assert.equal(functionSignature(pgFunction('f', {returns: 'void', body: ''})), '{"returns":"void","args":[]}');
	assert.equal(functionSignature(pgFunction('f', {args: [{type: 'int'}], returns: 'void', body: ''})), '{"returns":"void","args":[[null,null]]}');
});

test('createTriggerSql renders a row trigger', () => {
	const trigger = pgTrigger('users_touch', {table: users, timing: 'before', events: ['update'], function: touch});
	assert.equal(createTriggerSql(trigger, undefined), [
		'CREATE TRIGGER "users_touch"',
		'BEFORE UPDATE ON "users"',
		'FOR EACH ROW',
		'EXECUTE FUNCTION "touch"();',
	].join('\n'));
	assert.equal(dropTriggerSql(trigger), 'DROP TRIGGER IF EXISTS "users_touch" ON "users";');
	assert.equal(triggerIdentity(trigger), 'public.users.users_touch');
	assert.equal(triggerFunctionIdentity(trigger, undefined), 'public.touch()');
});

test('createTriggerSql renders events in a fixed order, columns, conditions and arguments with casing', () => {
	const trigger = pgTrigger('posts_audit', {
		table: auditedPosts,
		timing: 'after',
		events: ['delete', 'update', 'insert'],
		columns: [auditedPosts.status, 'title'],
		when: ({NEW, OLD}) => sql`${NEW.status} IS DISTINCT FROM ${OLD.status} AND ${NEW.commentCount} > ${0}`,
		function: {schema: 'audit', name: 'log_change'},
		args: ['posts', 1, auditedPosts.commentCount, 'it\'s'],
	});
	assert.equal(createTriggerSql(trigger, 'snake_case'), [
		'CREATE TRIGGER "posts_audit"',
		'AFTER INSERT OR UPDATE OF "status", "title" OR DELETE ON "app"."posts"',
		'FOR EACH ROW',
		'WHEN (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."comment_count" > 0)',
		'EXECUTE FUNCTION "audit"."log_change"(\'posts\', \'1\', \'comment_count\', \'it\'\'s\');',
	].join('\n'));
	assert.match(createTriggerSql(trigger, undefined), /NEW."commentCount" > 0\)\nEXECUTE FUNCTION "audit"."log_change"\('posts', '1', 'commentCount'/);
	assert.equal(triggerIdentity(trigger), 'app.posts.posts_audit');
	assert.equal(triggerFunctionIdentity(trigger, undefined), 'audit.log_change()');
});

test('createTriggerSql renders statement triggers, transition tables and plain conditions', () => {
	const trigger = pgTrigger('posts_bulk', {
		table: {name: 'archive'},
		timing: 'after',
		events: ['insert', 'truncate'],
		forEach: 'statement',
		referencing: {newTable: 'inserted'},
		when: 'pg_trigger_depth() = 0',
		function: touch,
	});
	assert.equal(createTriggerSql(trigger, undefined), [
		'CREATE TRIGGER "posts_bulk"',
		'AFTER INSERT OR TRUNCATE ON "archive"',
		'REFERENCING NEW TABLE AS "inserted"',
		'FOR EACH STATEMENT',
		'WHEN (pg_trigger_depth() = 0)',
		'EXECUTE FUNCTION "touch"();',
	].join('\n'));
	const both = pgTrigger('t', {table: users, timing: 'after', events: ['update'], referencing: {newTable: 'n', oldTable: 'o'}, when: sql`true`, function: touch});
	assert.match(createTriggerSql(both, undefined), /\nREFERENCING NEW TABLE AS "n" OLD TABLE AS "o"\n/);
	assert.match(createTriggerSql(both, undefined), /\nWHEN \(true\)\n/);
	const oldOnly = pgTrigger('t', {table: users, timing: 'after', events: ['delete'], referencing: {oldTable: 'o'}, function: touch});
	assert.match(createTriggerSql(oldOnly, undefined), /\nREFERENCING OLD TABLE AS "o"\n/);
	assert.equal(triggerIdentity(pgTrigger('t', {table: {schema: 'x', name: 'v'}, timing: 'after', events: ['insert'], function: touch})), 'x.v.t');
});
