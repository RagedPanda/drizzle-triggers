import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {applyDefinitions, buildSnapshot, pgFunction, pgTrigger, updatedAtTrigger, type Definition} from '../src/index.ts';
import {posts, users} from './fixtures.ts';

// These checks run when `npm run typecheck` compiles this file; the test only makes sure it loads.
const touch = pgFunction('touch', {returns: 'trigger', body: 'BEGIN RETURN NEW; END;'});

const postsStatus = pgTrigger('posts_status', {
	table: posts,
	timing: 'after',
	events: ['update'],
	// NEW and OLD are keyed by the table's Drizzle column keys.
	when: ({NEW, OLD}) => sql`${NEW.status} IS DISTINCT FROM ${OLD.status} AND ${NEW.commentCount} > 0`,
	function: touch,
});

pgTrigger('users_name', {
	table: users,
	timing: 'after',
	events: ['update'],
	// @ts-expect-error: users has no status column.
	when: ({NEW}) => sql`${NEW.status} IS NOT NULL`,
	function: touch,
});

// Triggers on different tables, functions and recipes all fit in one list.
const definitions: Definition[] = [touch, postsStatus, updatedAtTrigger(users, users.updatedAt)];
const runApply = (execute: (query: unknown) => Promise<unknown>) => applyDefinitions({execute}, definitions);

test('the type checks in this file compile', () => {
	assert.equal(typeof runApply, 'function');
	assert.equal(buildSnapshot(definitions, undefined).triggers.size, 2);
});
