import assert from 'node:assert/strict';
import {test} from 'node:test';
import {date, pgTable, text, timestamp} from 'drizzle-orm/pg-core';
import {createFunctionSql, createTriggerSql, dropFunctionSql, functionIdentity} from '../src/render.ts';
import {buildSnapshot} from '../src/snapshot.ts';
import {updatedAtFunction, updatedAtTrigger} from '../src/recipes.ts';
import {posts, users} from './fixtures.ts';

test('updatedAtTrigger names the trigger after the table and column, and passes the column', () => {
	const trigger = updatedAtTrigger(posts, posts.updatedAt);
	assert.equal(trigger.name, 'posts_set_updated_at');
	assert.equal(trigger.timing, 'before');
	assert.deepEqual(trigger.events, ['update']);
	assert.equal(trigger.args, undefined);
	assert.equal(trigger.function, updatedAtFunction(posts.updatedAt));
	assert.equal(updatedAtTrigger(users, users.updatedAt, {name: 'touch'}).name, 'touch');
});

test('updatedAtTrigger accepts every timestamp and date column', () => {
	const events = pgTable('events', {
		at: timestamp(), atZoned: timestamp({withTimezone: true, mode: 'string'}), day: date(), dayAsDate: date({mode: 'date'}),
	});
	for (const column of [events.at, events.atZoned, events.day, events.dayAsDate]) {
		assert.doesNotThrow(() => updatedAtTrigger(events, column));
	}
});

test('updatedAtTrigger explains a column from another table or of the wrong type', () => {
	assert.throws(() => updatedAtTrigger(posts, users.updatedAt), /updatedAtTrigger\(posts\): the column updated_at belongs to another table/);
	const notes = pgTable('notes', {body: text()});
	assert.throws(() => updatedAtTrigger(notes, notes.body), /notes\): body is text, but now\(\) needs a timestamp, timestamptz or date column/);
});

test('updatedAtFunction assigns the column by its database name, with casing applied', () => {
	const articles = pgTable('articles', {updatedAt: timestamp()});
	const touch = updatedAtFunction(articles.updatedAt);
	assert.equal(touch.name, 'drizzle_triggers_set_updatedAt');
	assert.equal(createFunctionSql(touch, 'snake_case'), [
		'CREATE OR REPLACE FUNCTION "drizzle_triggers_set_updated_at"()',
		'RETURNS trigger',
		'LANGUAGE plpgsql',
		'VOLATILE',
		'AS $body$',
		'BEGIN',
		'\tNEW."updated_at" := now();',
		'\tRETURN NEW;',
		'END;',
		'$body$;',
	].join('\n'));
	assert.match(createFunctionSql(touch, undefined), /^CREATE OR REPLACE FUNCTION "drizzle_triggers_set_updatedAt"\(\)[^]*NEW."updatedAt" := now\(\);/);
	assert.match(createFunctionSql(updatedAtFunction(users.updatedAt), 'camelCase'), /"drizzle_triggers_set_updated_at"\(\)[^]*NEW."updated_at" := now\(\);/);
	assert.equal(dropFunctionSql(touch, 'snake_case'), 'DROP FUNCTION IF EXISTS "drizzle_triggers_set_updated_at"();');
	assert.equal(functionIdentity(touch, undefined), 'public.drizzle_triggers_set_updatedAt()');
	assert.match(createTriggerSql(updatedAtTrigger(articles, articles.updatedAt), 'snake_case'), /EXECUTE FUNCTION "drizzle_triggers_set_updated_at"\(\);$/);
});

test('updatedAtFunction shares one function per column name and naming mode', () => {
	const articles = pgTable('articles', {updatedAt: timestamp()});
	const comments = pgTable('comments', {updatedAt: timestamp()});
	const notes = pgTable('notes', {changed: timestamp('updatedAt')});
	assert.equal(updatedAtFunction(comments.updatedAt), updatedAtFunction(articles.updatedAt));
	assert.notEqual(updatedAtFunction(notes.changed), updatedAtFunction(articles.updatedAt));
});

test('updatedAtTrigger gives columns with different database names their own function', () => {
	// Without casing, a key-named updatedAt is "updatedAt" in the database, next to an explicit "updated_at".
	const articles = pgTable('articles', {updatedAt: timestamp()});
	const comments = pgTable('comments', {updatedAt: timestamp('updated_at')});
	const snapshot = buildSnapshot([updatedAtTrigger(articles, articles.updatedAt), updatedAtTrigger(comments, comments.updatedAt)], undefined);
	assert.deepEqual([...snapshot.functions.keys()], ['public.drizzle_triggers_set_updatedAt()', 'public.drizzle_triggers_set_updated_at()']);
	assert.deepEqual([...snapshot.triggers.values()].map(trigger => trigger.function), [...snapshot.functions.keys()]);
});

test('updatedAtFunction rejects a column whose name with casing makes the function name too long', () => {
	const wide = pgTable('wide', {[`x${'Ab'.repeat(20)}`]: timestamp()});
	const touch = updatedAtFunction(wide[`x${'Ab'.repeat(20)}`]!);
	assert.doesNotThrow(() => createFunctionSql(touch, undefined));
	assert.throws(() => createFunctionSql(touch, 'snake_case'), /updatedAtFunction\(x_ab_ab[_a-z]*\) must be at most 63 bytes/);
});
