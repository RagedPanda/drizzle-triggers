import * as pgCore from 'drizzle-orm/pg-core';
import {integer, pgSchema, pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';

// Drizzle 1.0 snake-cases key-named columns in the table builder; before 1.0 the `casing` option does it.
// The tests use whichever the installed version has, so the same database tables fit both.
const snakeCase = (pgCore as {snakeCase?: {table: typeof pgTable; schema: typeof pgSchema}}).snakeCase;

/** `pgTable`, snake-casing key-named columns on Drizzle 1.0. */
export const snakeTable: typeof pgTable = snakeCase?.table ?? pgTable;

export const users = pgTable('users', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const app = (snakeCase?.schema ?? pgSchema)('app');

export const posts = app.table('posts', {
	id: serial().primaryKey(),
	title: text().notNull(),
	status: text().notNull().default('draft'),
	commentCount: integer().notNull().default(0),
	updatedAt: timestamp({withTimezone: true}).defaultNow().notNull(),
});
