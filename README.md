# drizzle-triggers

Postgres functions and triggers for [Drizzle ORM](https://orm.drizzle.team). Define them next to your tables in TypeScript, and get them as ordinary Drizzle migrations.

```ts
import {pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';
import {updatedAtTrigger} from 'drizzle-triggers';

export const posts = pgTable('posts', {
	id: serial('id').primaryKey(),
	title: text('title').notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const postsUpdatedAt = updatedAtTrigger(posts, posts.updatedAt);
```

```sh
npx drizzle-kit generate && npx drizzle-triggers generate
```

## Why

Drizzle Kit generates migrations for tables, indexes, views and policies, but not for functions or triggers ([drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843), open since 2023). Today you have two options, and both have problems:

- **`$onUpdate(() => new Date())`** runs in your app. Updates that don't go through Drizzle never run it: raw SQL, another service, a `psql` session, or a bulk `UPDATE` from a migration. The column quietly goes stale.
- **A hand-written custom migration** (`drizzle-kit generate --custom`) works, but the trigger now lives in a SQL file with nothing to tie it to your schema. You have to remember to write a drop-and-create migration every time you change it. Rename a column and nothing tells you the trigger still points at the old name.

drizzle-triggers keeps the definitions in your schema, type-checked against your tables. It writes the migration for you, holding only what changed: new functions and triggers are created, changed ones replaced, removed ones dropped. `drizzle-triggers check` fails CI when a definition changed without a migration.

It doesn't replace Drizzle Kit, and it doesn't patch it. It writes into the custom migration that `drizzle-kit generate --custom` creates, so Drizzle's own migrator runs it in order with everything else.

## Install

```sh
npm install drizzle-triggers
```

You need `drizzle-orm` 0.36.4 or later, including 1.0. Migrations also need `drizzle-kit` 0.28.1 or later. Triggers run on PostgreSQL 11 or later. Node.js 22.12 or later is required for the CLI.

## Usage

### 1. Define triggers in your schema

Put definitions in any file your `drizzle.config.ts` `schema` points at, and export them like your tables. A trigger brings its function with it, so you only need to export the trigger.

#### Keep `updatedAt` current

```ts
export const postsUpdatedAt = updatedAtTrigger(posts, posts.updatedAt);
```

This sets the column to `now()` before every update, however the update is made. Give the column a `.defaultNow()` for inserts. Tables whose column has the same database name share one function, named after that column: `updated_at` gives `drizzle_triggers_set_updated_at`, and a key-named `updatedAt` with no casing gives `drizzle_triggers_set_updatedAt`.

#### Write your own

```ts
import {sql} from 'drizzle-orm';
import {pgFunction, pgTrigger} from 'drizzle-triggers';

export const rejectNegativeLikes = pgFunction('reject_negative_likes', {
	returns: 'trigger',
	body: `BEGIN RAISE EXCEPTION 'likes cannot go below zero'; END;`,
});

export const postsNoNegativeLikes = pgTrigger('posts_no_negative_likes', {
	table: posts,
	timing: 'before',
	events: ['update'],
	columns: [posts.likes],
	when: ({NEW}) => sql`${NEW.likes} < 0`,
	function: rejectNegativeLikes,
});
```

The `when` callback receives `NEW` and `OLD` keyed by your Drizzle column keys. `NEW.likes` is type-checked, and it renders as the real column name with your `casing` applied.

#### Keep a counter in sync, once per statement

```ts
export const countPosts = pgFunction('count_posts', {
	returns: 'trigger',
	body: sql`BEGIN
		UPDATE ${stats} SET total = total + (SELECT count(*) FROM inserted);
		RETURN NULL;
	END;`,
});

export const postsCount = pgTrigger('posts_count', {
	table: posts,
	timing: 'after',
	events: ['insert'],
	forEach: 'statement',
	referencing: {newTable: 'inserted'},
	function: countPosts,
});
```

`body` and `when` accept a plain string or a Drizzle `sql` template. Tables render as their quoted, schema-qualified names, and interpolated values are inlined as literals, because DDL cannot take bind parameters.

#### Use something that already exists

`table` and `function` also accept a `{name, schema}` reference. Use it for a view, for a table you don't define with Drizzle, or for a function from an extension:

```ts
export const postsAudit = pgTrigger('posts_audit', {
	table: posts,
	timing: 'after',
	events: ['insert', 'update', 'delete'],
	function: {schema: 'audit', name: 'log_change'},
	args: ['posts', posts.id],
});
```

### 2. Generate migrations

Run Drizzle Kit first, then drizzle-triggers. Add it to your scripts:

```json
{
	"scripts": {
		"db:generate": "drizzle-kit generate && drizzle-triggers generate",
		"db:migrate": "drizzle-kit migrate"
	}
}
```

`drizzle-triggers generate` reads your `drizzle.config.ts` the way Drizzle Kit does, including TypeScript and extensionless imports. It compares your definitions with the last migration it wrote. If something changed, it has Drizzle Kit create a custom migration and fills it in. If nothing changed, it writes nothing.

Apply migrations however you do today: `drizzle-kit migrate`, or `migrate()` from `drizzle-orm/<driver>/migrator`.

### 3. Check in CI

```sh
npx drizzle-triggers check
```

It exits with 1 and prints the pending statements when a definition changed without a migration.

### Without migrations

If you use `drizzle-kit push`, or set up a test database from scratch, apply the definitions directly:

```ts
import {applyDefinitions} from 'drizzle-triggers';
import * as schema from './db/schema';

await db.transaction(tx => applyDefinitions(tx, [schema.postsUpdatedAt, schema.postsNoNegativeLikes]));
```

`applyDefinitions` can run again safely. `npx drizzle-triggers sql` prints the same statements.

## API

### `pgFunction(name, options)`

Defines a function. The result is frozen and can be exported, or used as a trigger's `function`.

| Option | Type | Default | |
| --- | --- | --- | --- |
| `returns` | `string` | required | `trigger`, `void`, `integer`, `setof "users"` and so on |
| `body` | `string \| SQL` | required | Without the dollar quotes; those are added for you |
| `args` | `{name?, type, default?}[]` | `[]` | `default` is a SQL expression, such as `0` or `'pending'` |
| `schema` | `string` | first in `search_path` | |
| `language` | `string` | `plpgsql` | |
| `volatility` | `'volatile' \| 'stable' \| 'immutable'` | `volatile` | |
| `strict` | `boolean` | `false` | Returns null without running when any argument is null |
| `security` | `'invoker' \| 'definer'` | `invoker` | |
| `searchPath` | `string[]` | not set | Pins `search_path` while the function runs. Always set it with `security: 'definer'`. `[]` sets it to empty |
| `parallel` | `'unsafe' \| 'restricted' \| 'safe'` | Postgres default | |
| `leakproof` | `boolean` | `false` | |

### `pgTrigger(name, options)`

Defines a trigger.

| Option | Type | Default | |
| --- | --- | --- | --- |
| `table` | Drizzle table or `{name, schema?}` | required | |
| `timing` | `'before' \| 'after' \| 'instead of'` | required | `instead of` is for views and needs `forEach: 'row'` |
| `events` | `('insert' \| 'update' \| 'delete' \| 'truncate')[]` | required | `truncate` needs `forEach: 'statement'` |
| `function` | `pgFunction()` result or `{name, schema?}` | required | A `pgFunction()` here must return `trigger` and take no arguments |
| `columns` | `(column \| string)[]` | all | `UPDATE OF`: fire only when one of these is in the `SET` list. Needs the `update` event |
| `forEach` | `'row' \| 'statement'` | `row` | |
| `when` | `string \| SQL \| ({NEW, OLD}) => SQL` | none | The callback form needs a Drizzle `table` |
| `referencing` | `{newTable?, oldTable?}` | none | Transition tables for `after ... forEach: 'statement'` triggers |
| `args` | `(string \| number \| column)[]` | `[]` | Available as `TG_ARGV`. A column is passed as its database name |

Both functions validate their options when your schema loads. They throw a `TypeError` that names the option, such as `pgTrigger('posts_audit') columns only apply to the update event`. A name longer than Postgres's 63-byte limit also throws, since Postgres would cut it short silently.

### `updatedAtTrigger(table, column, {name?})`

A `before update` trigger that sets `column` to `now()`. `column` must belong to `table` and be a `timestamp`, `timestamptz` or `date`. The default name is `<table>_set_<column>`, such as `posts_set_updated_at`.

### `updatedAtFunction(column)`

The function `updatedAtTrigger` uses: `drizzle_triggers_set_<column>`, which assigns `NEW.<column> := now()`. `<column>` is the column's database name after casing, so columns that differ only in casing never share a function.

### `applyDefinitions(db, definitions, {casing?})`

Drops each trigger if it exists, then creates or replaces every function, then creates every trigger. `db` is any Drizzle Postgres database or transaction. Pass the `casing` you pass to `drizzle()`.

### `collectDefinitions(moduleExports)`

Finds the functions and triggers among a module's exports, including inside exported arrays and plain objects. Pass it `await import('./schema')`.

### Lower-level building blocks

These are what the CLI is made of, for custom tooling:

- `buildSnapshot(definitions, casing)` renders every definition. It adds the function each trigger uses, and throws when two different definitions share a name.
- `diff(previousState, snapshot)` returns the statements that move a database from one state to the next. It drops triggers, then drops functions, then creates or replaces functions, then creates triggers.
- `idempotentStatements(snapshot)` returns the statements `applyDefinitions` runs.
- `toState`, `emptyState`, `renderMigration`, `readState` and `latestState` read and write the state saved at the end of each generated migration.
- `createFunctionSql`, `dropFunctionSql`, `createTriggerSql` and `dropTriggerSql` render a single statement.
- `isFunctionDefinition`, `isTriggerDefinition` and `columnName` are also exported.

### CLI

```
drizzle-triggers <command> [options]

  generate   Write a migration for the functions and triggers that changed
  check      Exit with 1 when a definition changed without a migration for it
  sql        Print SQL that creates or replaces every function and trigger

  -c, --config <file>  The drizzle-kit config, by default drizzle.config.ts
  --name <name>        The migration name for generate, by default "triggers"
```

## Benchmarks

These benchmarks measure what an `updatedAt` trigger costs Postgres, compared with the other ways to keep the column current. They also measure what drizzle-triggers costs when it generates migrations.

**Method.** A table of 100,000 rows: `id`, `title`, `views`, a 240-character `body` and `updated_at timestamptz`. Each approach runs the same `UPDATE posts SET views = views + 1` over every row. The no-trigger baseline sets `updated_at = now()` in the statement itself, which is what Drizzle's `$onUpdate` sends. Each approach gets a fresh table, two warmup runs, then seven timed runs. The table shows the median.

**Machine.** PostgreSQL 14.24 (Homebrew, default settings) on an Apple M5, macOS, Node.js 24.17.0, connected over TCP on localhost.

| Approach | Median | vs. no trigger |
| --- | ---: | ---: |
| No trigger, `SET updated_at = now()` (what `$onUpdate` sends) | 1279 ms | 1.00x |
| **drizzle-triggers `updatedAtTrigger()`** | **1787 ms** | **1.40x** |
| [`moddatetime`](https://www.postgresql.org/docs/current/contrib-spi.html#CONTRIB-SPI-MODDATETIME) extension (Postgres contrib) | 2366 ms | 1.85x |
| Generic trigger, column name as argument (`jsonb_populate_record`) | 2389 ms | 1.87x |

A row trigger is never free: it runs once per updated row. But drizzle-triggers' function is the plain `NEW.updated_at := now()` you would write by hand. It costs about 5 µs per row here, about half the overhead of `moddatetime` or a generic, argument-driven function. That is why `updatedAtTrigger` generates one small function per column name instead of one generic function. Only `$onUpdate` is cheaper, and it misses every update that doesn't go through Drizzle.

Generating migrations costs almost nothing:

| Tables with an `updatedAt` trigger | Build and diff | Memory kept |
| ---: | ---: | ---: |
| 10 | 1.1 ms | 85 KB |
| 100 | 1.6 ms | 97 KB |
| 1000 | 13.9 ms | 1047 KB |

The library has one runtime dependency, [jiti](https://github.com/unjs/jiti), which only the CLI loads, to read TypeScript schemas the way Drizzle Kit does. Your app never loads it. The whole package is 24 kB packed.

**Run it yourself:**

```sh
npm run bench                                                  # in-process PGlite, no setup
BENCH_DATABASE_URL=postgres://user@localhost:5432/db npm run bench  # a real server
```

`BENCH_ROWS` and `BENCH_RUNS` change the table size and run count. The benchmark works in a throwaway schema, `drizzle_triggers_bench`, and drops it afterwards. Use a real server for numbers worth comparing: PGlite runs Postgres as WebAssembly inside Node.js, and its timings vary too much between approaches to rank them.

## Good to know

- **Run `drizzle-kit generate` first.** The trigger migration has to come after the migration that creates its table. The `db:generate` script above does both in the right order.
- **Removing a column a trigger uses takes two steps.** A trigger with `columns: [posts.likes]`, or a `when` that reads `likes`, depends on that column, so Postgres refuses to drop it. First change the trigger and run `db:generate`. Then remove the column and run it again.
- **Merging branches.** Like Drizzle Kit's snapshots, each generated migration ends with a `-- drizzle-triggers:state` line, and the next migration diffs against the newest one. If two branches both generate trigger migrations, keep one after merging. Delete the other one's migration (and its journal entry on Drizzle Kit 0.x), then run `drizzle-triggers generate` again.
- **`applyDefinitions` and `sql` don't remove anything.** They create or replace what you define, but leave alone a function or trigger you have deleted from your schema. Migrations do drop them.
- **A function whose return type, argument names or defaults change is dropped and created again**, since `CREATE OR REPLACE` cannot change those. The triggers that use it are recreated with it. A changed trigger is also dropped and created again, inside the same migration.
- **Casing.** On Drizzle 0.x, the `casing` in your `drizzle.config.ts` applies to key-named columns, just as Drizzle Kit applies it. Drizzle 1.0 applies casing in the table builder (`snakeCase.table()`) and ignores the config option, and so does drizzle-triggers.
- **PostgreSQL only.** Drizzle's MySQL and SQLite dialects aren't supported.
- **If Drizzle adds native trigger support** ([#843](https://github.com/drizzle-team/drizzle-orm/issues/843)), switching over is straightforward. Your existing migrations stay valid, because they are plain SQL. Replace the definitions with Drizzle's own, and let it generate from there.

## Related

- [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843): the feature request for triggers and functions in Drizzle Kit.
- [drizzle-orm#4844](https://github.com/drizzle-team/drizzle-orm/pull/4844) and [#5373](https://github.com/drizzle-team/drizzle-orm/pull/5373): proposals to add them to Drizzle itself.
- [`moddatetime`](https://www.postgresql.org/docs/current/contrib-spi.html#CONTRIB-SPI-MODDATETIME): Postgres's contrib function for `updated_at` columns, compared in the benchmarks above.

## License

MIT
