import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {PgDialect, pgTable, text, timestamp} from 'drizzle-orm/pg-core';
import {columnName, effectiveCasing, rowReferences} from '../src/columns.ts';

const posts = pgTable('posts', {
	updatedAt: timestamp(),
	title: text('Title'),
	snake_key: text(),
});

test('columnName keeps explicit names and applies casing to key names', () => {
	assert.equal(columnName(posts.updatedAt, undefined), 'updatedAt');
	assert.equal(columnName(posts.updatedAt, 'snake_case'), 'updated_at');
	assert.equal(columnName(posts.snake_key, 'camelCase'), 'snakeKey');
	assert.equal(columnName(posts.title, 'snake_case'), 'Title');
});

test('rowReferences renders NEW and OLD columns by their database names', () => {
	const references = rowReferences(posts, 'NEW', 'snake_case');
	assert.deepEqual(Object.keys(references), ['updatedAt', 'title', 'snake_key']);
	const rendered = new PgDialect().sqlToQuery(sql`${references.updatedAt} > ${rowReferences(posts, 'OLD', undefined).title}`).sql;
	assert.equal(rendered, 'NEW."updated_at" > OLD."Title"');
});

test('effectiveCasing drops the casing when the table builders apply it, as on Drizzle 1.0', () => {
	assert.equal(effectiveCasing('snake_case', false), 'snake_case');
	assert.equal(effectiveCasing(undefined, false), undefined);
	assert.equal(effectiveCasing('snake_case', true), undefined);
});
