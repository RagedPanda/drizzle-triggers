import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertName, dollarQuote, qualifiedName, quoteIdentifier, quoteLiteral} from '../src/identifiers.ts';

test('quoteIdentifier quotes and doubles inner quotes', () => {
	assert.equal(quoteIdentifier('users'), '"users"');
	assert.equal(quoteIdentifier('my "table"'), '"my ""table"""');
});

test('qualifiedName adds the schema when there is one', () => {
	assert.equal(qualifiedName('posts', undefined), '"posts"');
	assert.equal(qualifiedName('posts', 'app'), '"app"."posts"');
});

test('quoteLiteral doubles single quotes', () => {
	assert.equal(quoteLiteral('it\'s'), '\'it\'\'s\'');
});

test('dollarQuote picks a tag that is not in the body', () => {
	assert.equal(dollarQuote('BEGIN END;'), '$body$\nBEGIN END;\n$body$');
	assert.equal(dollarQuote('a $body$ b $body_1$'), '$body_2$\na $body$ b $body_1$\n$body_2$');
});

test('assertName accepts non-empty strings and rejects anything else', () => {
	assertName('x', 'name');
	for (const invalid of ['', '  ', undefined, 3]) {
		assert.throws(() => assertName(invalid, 'name'), {name: 'TypeError', message: /^name must be a non-empty string/});
	}
});
