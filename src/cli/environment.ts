import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {createJiti} from 'jiti';
import type {CliEnvironment} from './run.ts';

type Manifest = {name?: string; bin?: string | Record<string, string>};

/** The path of drizzle-kit's CLI script, installed in the project at `cwd`. */
export function drizzleKitBin(cwd: string): string {
	// drizzle-kit does not export its package.json, so walk up from its entry point to find it.
	let folder = path.dirname(createRequire(path.join(cwd, 'package.json')).resolve('drizzle-kit'));
	const readManifest = (): Manifest => {
		const file = path.join(folder, 'package.json');
		return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Manifest : {};
	};

	let manifest = readManifest();
	while (manifest.name !== 'drizzle-kit') {
		folder = path.dirname(folder);
		manifest = readManifest();
	}

	const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['drizzle-kit'];
	if (bin === undefined) {
		throw new Error(`drizzle-kit in ${folder} has no drizzle-kit bin`);
	}

	return path.resolve(folder, bin);
}

/** A process killed by a signal has no exit status; report it as a failure. */
export function exitCode(status: number | null): number {
	return status ?? 1;
}

/** The real environment: jiti loads TypeScript schema files with the same import rules as drizzle-kit. */
export function nodeEnvironment(cwd: string): CliEnvironment {
	const jiti = createJiti(pathToFileURL(path.join(cwd, 'index.js')).href, {interopDefault: false});
	return {
		cwd,
		print: text => process.stdout.write(`${text}\n`),
		printError: text => process.stderr.write(`${text}\n`),
		importModule: file => jiti.import(file),
		runDrizzleKit: args => exitCode(spawnSync(process.execPath, [drizzleKitBin(cwd), ...args], {cwd, stdio: 'inherit'}).status),
		sleep: milliseconds => setTimeout(milliseconds),
	};
}
