/** Quotes a Postgres identifier: `user name` becomes `"user name"`, and inner quotes are doubled. */
export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** `"schema"."name"`, or just `"name"` when there is no schema, which then resolves through the `search_path`. */
export function qualifiedName(name: string, schema: string | undefined): string {
	return schema === undefined ? quoteIdentifier(name) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

/** Quotes a Postgres string literal: `it's` becomes `'it''s'`. */
export function quoteLiteral(value: string): string {
	return `'${value.replaceAll('\'', '\'\'')}'`;
}

/**
 * Wraps a function body in dollar quotes whose tag does not occur in the body,
 * so the body never needs escaping: `$body$`, else `$body_1$`, `$body_2$`, and so on.
 */
export function dollarQuote(body: string): string {
	let tag = '$body$';
	for (let attempt = 1; body.includes(tag); attempt++) {
		tag = `$body_${attempt}$`;
	}

	return `${tag}\n${body}\n${tag}`;
}

/** Throws unless `value` is a non-empty string; `label` names it in the error. */
export function assertName(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
	}
}

/** Postgres truncates longer identifiers silently, so two long names could end up the same. */
const maxIdentifierBytes = 63;

/** Throws unless `value` is a name Postgres keeps as written: non-empty and at most 63 bytes. */
export function assertIdentifier(value: unknown, label: string): asserts value is string {
	assertName(value, label);
	if (Buffer.byteLength(value) > maxIdentifierBytes) {
		throw new TypeError(`${label} must be at most ${maxIdentifierBytes} bytes, or Postgres cuts it short: ${JSON.stringify(value)}`);
	}
}

/** Throws unless `value` is an object, so a missing options argument gets a clear message. */
export function assertOptions(value: unknown, label: string): asserts value is object {
	if (typeof value !== 'object' || value === null) {
		throw new TypeError(`${label} needs an options object as its second argument`);
	}
}
