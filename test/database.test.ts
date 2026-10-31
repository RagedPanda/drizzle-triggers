import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {eq, sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/pglite';
import {integer, text, timestamp} from 'drizzle-orm/pg-core';
import {applyDefinitions} from '../src/apply.ts';
import {pgFunction, pgTrigger} from '../src/definitions.ts';
import {renderMigration, statementBreakpoint} from '../src/migration.ts';
import {updatedAtTrigger} from '../src/recipes.ts';
import {buildSnapshot, diff, emptyState, toState, type State} from '../src/snapshot.ts';
import {app, posts, snakeTable, users} from './fixtures.ts';

const schemaSql = `
	CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, updated_at timestamp DEFAULT now() NOT NULL);
	CREATE SCHEMA app;
	CREATE TABLE app.posts (
		id serial PRIMARY KEY, title text NOT NULL, status text DEFAULT 'draft' NOT NULL,
		comment_count integer DEFAULT 0 NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL
	);
	CREATE TABLE status_log (post_id integer, old_status text, new_status text);
	CREATE TABLE counts (label text PRIMARY KEY, total integer NOT NULL);
`;

const statusLog = snakeTable('status_log', {postId: integer(), oldStatus: text(), newStatus: text()});
const counts = snakeTable('counts', {label: text().primaryKey(), total: integer().notNull()});

async function createDatabase() {
	const client = new PGlite();
	await client.exec(schemaSql);
	return {client, db: drizzle({client, casing: 'snake_case'})};
}

/** Runs a migration file the way drizzle's migrator does: one statement per breakpoint. */
async function runMigration(client: PGlite, migration: string): Promise<void> {
	for (const statement of migration.split(statementBreakpoint)) {
		await client.exec(statement);
	}
}

const logStatus = pgFunction('log_status', {
	returns: 'trigger',
	body: 'BEGIN INSERT INTO status_log VALUES (NEW.id, OLD.status, NEW.status); RETURN NEW; END;',
});
const postsStatusLog = pgTrigger('posts_status_log', {
	table: posts,
	timing: 'after',
	events: ['update'],
	columns: [posts.status],
	when: ({NEW, OLD}) => sql`${NEW.status} IS DISTINCT FROM ${OLD.status}`,
	function: logStatus,
});

test('updatedAtTrigger sets the column on updates, for explicit and key-named columns', async () => {
	const {client, db} = await createDatabase();
	await applyDefinitions(db, [updatedAtTrigger(users, users.updatedAt), updatedAtTrigger(posts, posts.updatedAt)], {casing: 'snake_case'});
	await client.exec(`
		INSERT INTO users (name, updated_at) VALUES ('ada', '2000-01-01');
		INSERT INTO app.posts (title, updated_at) VALUES ('hello', '2000-01-01');
	`);
	const unchanged = await db.select({updatedAt: users.updatedAt}).from(users);
	assert.equal(unchanged[0]?.updatedAt.getUTCFullYear(), 2000);

	await client.exec('UPDATE users SET name = \'grace\'; UPDATE app.posts SET title = \'changed\';');
	const [user] = await db.select({updatedAt: users.updatedAt}).from(users);
	const [post] = await db.select({updatedAt: posts.updatedAt}).from(posts);
	assert.ok(user!.updatedAt.getUTCFullYear() > 2000);
	assert.ok(Math.abs(post!.updatedAt.getTime() - Date.now()) < 60_000);
	await client.close();
});

test('updatedAtTrigger reports a column the table does not have', async () => {
	const {client, db} = await createDatabase();
	// The schema says the column is touched_at, but the database table has updated_at.
	const stalePosts = app.table('posts', {touchedAt: timestamp('touched_at')});
	await applyDefinitions(db, [updatedAtTrigger(stalePosts, stalePosts.touchedAt)]);
	await client.exec('INSERT INTO app.posts (title) VALUES (\'hello\')');
	await assert.rejects(client.exec('UPDATE app.posts SET title = \'x\''), /record "new" has no field "touched_at"/);
	await client.close();
});

test('a WHEN condition with NEW and OLD columns fires only on real changes', async () => {
	const {client, db} = await createDatabase();
	await applyDefinitions(db, [postsStatusLog], {casing: 'snake_case'});
	await db.insert(posts).values({title: 'hello'});
	await db.update(posts).set({status: 'draft'});
	await db.update(posts).set({title: 'renamed'});
	await db.update(posts).set({status: 'published'});
	assert.deepEqual(await db.select().from(statusLog), [{postId: 1, oldStatus: 'draft', newStatus: 'published'}]);
	await client.close();
});

test('statement triggers see transition tables and get trigger arguments', async () => {
	const {client, db} = await createDatabase();
	const countRows = pgFunction('count_rows', {
		returns: 'trigger',
		body: `BEGIN
			INSERT INTO counts VALUES (TG_ARGV[0], (SELECT count(*) FROM inserted))
			ON CONFLICT (label) DO UPDATE SET total = counts.total + excluded.total;
			RETURN NULL;
		END;`,
	});
	const usersCount = pgTrigger('users_count', {
		table: users,
		timing: 'after',
		events: ['insert'],
		forEach: 'statement',
		referencing: {newTable: 'inserted'},
		function: countRows,
		args: ['users'],
	});
	await applyDefinitions(db, [usersCount]);
	await db.insert(users).values([{name: 'a'}, {name: 'b'}, {name: 'c'}]);
	await db.insert(users).values({name: 'd'});
	assert.deepEqual(await db.select().from(counts).where(eq(counts.label, 'users')), [{label: 'users', total: 4}]);
	await client.close();
});

test('applyDefinitions can run again, also after a function changed', async () => {
	const {client, db} = await createDatabase();
	await applyDefinitions(db, [postsStatusLog], {casing: 'snake_case'});
	await applyDefinitions(db, [postsStatusLog], {casing: 'snake_case'});
	const upperLog = pgFunction('log_status', {
		returns: 'trigger',
		body: 'BEGIN INSERT INTO status_log VALUES (NEW.id, upper(OLD.status), upper(NEW.status)); RETURN NEW; END;',
	});
	await db.transaction(tx => applyDefinitions(tx, [pgTrigger('posts_status_log', {...postsStatusLog, function: upperLog})], {casing: 'snake_case'}));
	await db.insert(posts).values({title: 'hello'});
	await db.update(posts).set({status: 'published'});
	assert.deepEqual(await db.select().from(statusLog), [{postId: 1, oldStatus: 'DRAFT', newStatus: 'PUBLISHED'}]);
	await client.close();
});

test('a sequence of migrations from diff() applies cleanly on a real database', async () => {
	const {client, db} = await createDatabase();
	const score = (returns: string, body: string) => pgFunction('score', {args: [{name: 'value', type: 'integer'}], returns, language: 'sql', volatility: 'immutable', body});
	const versions = [
		[postsStatusLog, updatedAtTrigger(users, users.updatedAt), score('integer', 'SELECT value * 2')],
		// The function body and the trigger condition change.
		[
			pgTrigger('posts_status_log', {...postsStatusLog, when: ({NEW}) => sql`${NEW.status} = 'published'`}),
			updatedAtTrigger(users, users.updatedAt),
			score('integer', 'SELECT value * 3'),
		],
		// The return type changes, so the function is dropped and created again.
		[updatedAtTrigger(users, users.updatedAt), score('bigint', 'SELECT value * 4')],
		[],
	];

	let previous: State = emptyState;
	const results = [];
	for (const definitions of versions) {
		const snapshot = buildSnapshot(definitions, 'snake_case');
		const statements = diff(previous, snapshot);
		await runMigration(client, renderMigration(statements, toState(snapshot)));
		previous = toState(snapshot);
		const scored = await db.execute<{score: string}>(sql`SELECT to_regprocedure('score(integer)') IS NOT NULL AND score(5)::text = ANY(ARRAY['10','15','20']) AS score`).catch(() => undefined);
		const triggers = await db.execute<{tgname: string}>(sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`);
		results.push({statements: statements.length, scored: scored?.rows[0]?.score, triggers: triggers.rows.map(row => row.tgname)});
	}

	assert.deepEqual(results, [
		{statements: 5, scored: true, triggers: ['posts_status_log', 'users_set_updated_at']},
		{statements: 3, scored: true, triggers: ['posts_status_log', 'users_set_updated_at']},
		{statements: 4, scored: true, triggers: ['users_set_updated_at']},
		{statements: 3, scored: undefined, triggers: []},
	]);
	await client.close();
});
