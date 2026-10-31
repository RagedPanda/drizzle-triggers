import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectDefinitions} from '../src/collect.ts';
import {pgFunction, pgTrigger} from '../src/definitions.ts';
import {users} from './fixtures.ts';

const touch = pgFunction('touch', {returns: 'trigger', body: ''});
const usersTouch = pgTrigger('users_touch', {table: users, timing: 'before', events: ['update'], function: touch});
const other = pgFunction('other', {returns: 'void', body: ''});
const nested = pgFunction('nested', {returns: 'void', body: ''});

test('collectDefinitions finds definitions in exports, arrays and plain objects, once each', () => {
	const found = collectDefinitions({
		users,
		touch,
		usersTouch,
		list: [other, touch, 'text'],
		group: {nested, count: 1},
		empty: null,
		number: 3,
		instance: new (class {
			hidden = pgFunction('hidden', {returns: 'void', body: ''});
		})(),
	});
	assert.deepEqual(found.map(definition => definition.name), ['touch', 'users_touch', 'other', 'nested']);
});
