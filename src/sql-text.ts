import type {SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {Casing} from './columns.ts';

/** SQL for a function body or a trigger condition: plain text, or a Drizzle `sql` template. */
export type SqlText = string | SQL;

/** One dialect per casing, made on first use: a dialect holds no per-query state, so it can be shared. */
const dialects = new Map<Casing | undefined, PgDialect>();

function dialectFor(casing: Casing | undefined): PgDialect {
	let dialect = dialects.get(casing);
	if (dialect === undefined) {
		dialect = new PgDialect(casing === undefined ? {} : {casing});
		dialects.set(casing, dialect);
	}

	return dialect;
}

/**
 * Renders `text` to a SQL string. Values interpolated into a `sql` template are inlined as literals,
 * because DDL cannot take bind parameters. Tables and columns render as their quoted names.
 */
export function renderSqlText(text: SqlText, casing: Casing | undefined): string {
	if (typeof text === 'string') {
		return text;
	}

	return dialectFor(casing).sqlToQuery(text.inlineParams()).sql;
}
