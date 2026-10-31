// Compares ways to keep an `updated_at` column current, and measures what drizzle-triggers costs at build time.
//
//   npm run bench                                         in-process PGlite, no setup
//   BENCH_DATABASE_URL=postgres://... npm run bench       a real Postgres server; uses a throwaway schema
//
// Every variant runs the same UPDATE over the same rows. The median of the timed runs is reported.
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {PGlite} from '@electric-sql/pglite';
import {moddatetime} from '@electric-sql/pglite/contrib/moddatetime';
import {integer, pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';
import pg from 'pg';
import {buildSnapshot, diff, emptyState, toState, updatedAtTrigger} from '../src/index.ts';

const rowCount = Number(process.env['BENCH_ROWS'] ?? 100_000);
const runs = Number(process.env['BENCH_RUNS'] ?? 7);
const warmups = 2;
const benchSchema = 'drizzle_triggers_bench';

type Database = {
	readonly name: string;
	readonly run: (statement: string) => Promise<void>;
	readonly close: () => Promise<void>;
};

async function openDatabase(url: string | undefined): Promise<Database> {
	if (url === undefined) {
		const client = await PGlite.create({extensions: {moddatetime}});
		const {rows} = await client.query<{server_version: string}>('SHOW server_version');
		return {name: `PGlite, PostgreSQL ${rows[0]!.server_version} (in process)`, run: async statement => void await client.exec(statement), close: () => client.close()};
	}

	const client = new pg.Client({connectionString: url});
	await client.connect();
	const {rows} = await client.query<{server_version: string}>('SHOW server_version');
	return {
		name: `PostgreSQL ${rows[0]!.server_version}`,
		run: async statement => void await client.query(statement),
		close: async () => {
			await client.query(`DROP SCHEMA IF EXISTS ${benchSchema} CASCADE`);
			await client.end();
		},
	};
}

const posts = pgTable('posts', {
	id: serial().primaryKey(),
	title: text().notNull(),
	views: integer().notNull(),
	body: text().notNull(),
	updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
});

/** The SQL drizzle-triggers generates for `updatedAtTrigger(posts, posts.updatedAt)`. */
const drizzleTriggersSql = diff(emptyState, buildSnapshot([updatedAtTrigger(posts, posts.updatedAt)], undefined)).join('\n');

type Variant = {
	readonly name: string;
	readonly setup: string;
	readonly update: string;
};

const variants: readonly Variant[] = [
	{
		name: 'No trigger, SET updated_at = now() (what $onUpdate sends)',
		setup: '',
		update: 'UPDATE posts SET views = views + 1, updated_at = now()',
	},
	{
		name: 'drizzle-triggers updatedAtTrigger()',
		setup: drizzleTriggersSql,
		update: 'UPDATE posts SET views = views + 1',
	},
	{
		name: 'moddatetime extension (Postgres contrib)',
		setup: `CREATE EXTENSION IF NOT EXISTS moddatetime;
			CREATE TRIGGER posts_moddatetime BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);`,
		update: 'UPDATE posts SET views = views + 1',
	},
	{
		name: 'Generic trigger, column name as argument (jsonb)',
		setup: `CREATE FUNCTION set_column_now() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now())); RETURN NEW; END; $$;
			CREATE TRIGGER posts_set_column_now BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION set_column_now('updated_at');`,
		update: 'UPDATE posts SET views = views + 1',
	},
];

function median(values: readonly number[]): number {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

async function timeVariant(database: Database, variant: Variant): Promise<number> {
	await database.run(`DROP SCHEMA IF EXISTS ${benchSchema} CASCADE; CREATE SCHEMA ${benchSchema}; SET search_path = ${benchSchema}, public;`);
	await database.run(`CREATE TABLE posts (id serial PRIMARY KEY, title text NOT NULL, views integer NOT NULL, body text NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL);
		INSERT INTO posts (title, views, body) SELECT 'post ' || n, n, repeat('lorem ipsum ', 20) FROM generate_series(1, ${rowCount}) AS n;
		${variant.setup}`);
	await database.run('VACUUM ANALYZE posts');

	const timings = [];
	for (let run = 0; run < warmups + runs; run++) {
		const start = performance.now();
		await database.run(variant.update);
		if (run >= warmups) {
			timings.push(performance.now() - start);
		}
	}

	return median(timings);
}

/** The time it takes to render and diff `tableCount` tables with an updatedAt trigger each, and the memory the result keeps. */
function measureBuild(tableCount: number): {milliseconds: number; retainedBytes: number} {
	const tables = Array.from({length: tableCount}, (_, index) => pgTable(`table_${index}`, {
		id: serial().primaryKey(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	}));
	globalThis.gc?.();
	const heapBefore = process.memoryUsage().heapUsed;
	const start = performance.now();
	const snapshot = buildSnapshot(tables.map(table => updatedAtTrigger(table, table.updatedAt)), undefined);
	const statements = diff(toState(snapshot), snapshot);
	const milliseconds = performance.now() - start;
	globalThis.gc?.();
	const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
	if (statements.length !== 0 || snapshot.triggers.size !== tableCount) {
		throw new Error('Expected one trigger per table, and no statements when a snapshot is diffed against itself');
	}

	return {milliseconds, retainedBytes};
}

const database = await openDatabase(process.env['BENCH_DATABASE_URL']);
console.log(`${database.name}, Node.js ${process.version}, ${os.cpus()[0]?.model ?? os.arch()}, ${os.platform()}`);
console.log(`UPDATE of ${rowCount.toLocaleString('en')} rows, median of ${runs} runs after ${warmups} warmups\n`);

try {
	const results = [];
	for (const variant of variants) {
		results.push({variant, milliseconds: await timeVariant(database, variant)});
	}

	const baseline = results[0]!.milliseconds;
	console.log('| Approach | Median | vs. no trigger |');
	console.log('| --- | ---: | ---: |');
	for (const {variant, milliseconds} of results) {
		console.log(`| ${variant.name} | ${milliseconds.toFixed(0)} ms | ${(milliseconds / baseline).toFixed(2)}x |`);
	}
} finally {
	await database.close();
}

console.log('\n| Tables with an updatedAt trigger | Build and diff | Memory kept |');
console.log('| ---: | ---: | ---: |');
for (const tableCount of [10, 100, 1000]) {
	const {milliseconds, retainedBytes} = measureBuild(tableCount);
	console.log(`| ${tableCount} | ${milliseconds.toFixed(1)} ms | ${(Math.max(retainedBytes, 0) / 1024).toFixed(0)} KB |`);
}
