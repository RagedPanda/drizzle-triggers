import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {drizzleKitBin, exitCode, nodeEnvironment} from '../src/cli/environment.ts';
import {temporaryProject} from './helpers.ts';

function fakeDrizzleKit(bin: unknown) {
	return {
		'node_modules/drizzle-kit/package.json': JSON.stringify({name: 'drizzle-kit', main: 'dist/index.js', bin}),
		'node_modules/drizzle-kit/dist/index.js': '',
		'node_modules/drizzle-kit/dist/package.json': JSON.stringify({type: 'commonjs'}),
	};
}

test('drizzleKitBin finds the bin from drizzle-kit\'s package.json', t => {
	const single = temporaryProject(t, fakeDrizzleKit('cli.js'));
	assert.equal(drizzleKitBin(single), path.join(single, 'node_modules/drizzle-kit/cli.js'));
	const named = temporaryProject(t, fakeDrizzleKit({'drizzle-kit': 'bin.cjs'}));
	assert.equal(drizzleKitBin(named), path.join(named, 'node_modules/drizzle-kit/bin.cjs'));
	const nested = temporaryProject(t, {
		'node_modules/drizzle-kit/package.json': JSON.stringify({name: 'drizzle-kit', main: 'lib/api/index.js', bin: 'cli.js'}),
		'node_modules/drizzle-kit/lib/api/index.js': '',
	});
	assert.equal(drizzleKitBin(nested), path.join(nested, 'node_modules/drizzle-kit/cli.js'));
	const none = temporaryProject(t, fakeDrizzleKit(undefined));
	assert.throws(() => drizzleKitBin(none), /has no drizzle-kit bin/);
});

test('nodeEnvironment imports TypeScript with extensionless imports and runs drizzle-kit', async t => {
	const cwd = temporaryProject(t, {
		'schema.ts': 'import {answer} from \'./answer\';\nexport const value: number = answer;\n',
		'answer.ts': 'export const answer = 42;\n',
	});
	const environment = nodeEnvironment(cwd);
	assert.equal(environment.cwd, cwd);
	assert.deepEqual({...await environment.importModule(path.join(cwd, 'schema.ts')) as object}, {value: 42});
	assert.equal(environment.runDrizzleKit(['--version']), 0);
	await environment.sleep(1);

	const written: string[] = [];
	t.mock.method(process.stdout, 'write', (text: string) => written.push(text));
	t.mock.method(process.stderr, 'write', (text: string) => written.push(text));
	environment.print('out');
	environment.printError('error');
	t.mock.restoreAll();
	assert.deepEqual(written, ['out\n', 'error\n']);
});

test('exitCode treats a missing status, from a killed process, as a failure', () => {
	assert.equal(exitCode(0), 0);
	assert.equal(exitCode(2), 2);
	assert.equal(exitCode(null), 1);
});
