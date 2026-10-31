import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {collectDefinitions} from '../collect.ts';
import type {Definition} from '../definitions.ts';
import {latestState, renderMigration} from '../migration.ts';
import {buildSnapshot, diff, emptyState, idempotentStatements, toState, type Snapshot} from '../snapshot.ts';
import {findConfigFile, migrationFiles, parseConfig, schemaFiles, type ProjectConfig} from './project.ts';

/** Everything the CLI does outside this module, so tests can replace it. */
export type CliEnvironment = {
	readonly cwd: string;
	readonly print: (text: string) => void;
	readonly printError: (text: string) => void;
	/** Imports a TypeScript or JavaScript module the way drizzle-kit does. */
	readonly importModule: (file: string) => Promise<unknown>;
	/** Runs drizzle-kit with `args` and returns its exit code. */
	readonly runDrizzleKit: (args: readonly string[]) => number;
	readonly sleep: (milliseconds: number) => Promise<void>;
};

export const usage = `Usage: drizzle-triggers <command> [options]

Commands:
  generate   Write a migration for the functions and triggers that changed
  check      Exit with 1 when a definition changed without a migration for it
  sql        Print SQL that creates or replaces every function and trigger

Options:
  -c, --config <file>  The drizzle-kit config, by default drizzle.config.ts
  --name <name>        The migration name for generate, by default "triggers"
  -h, --help           Show this help
`;

type Project = {
	readonly configFile: string;
	readonly config: ProjectConfig;
	readonly snapshot: Snapshot;
};

async function loadProject(environment: CliEnvironment, requestedConfig: string | undefined): Promise<Project> {
	const configFile = findConfigFile(environment.cwd, requestedConfig);
	const config = parseConfig(await environment.importModule(configFile));
	const files = schemaFiles(environment.cwd, config.schema);
	if (files.length === 0) {
		throw new Error(`No schema files match ${config.schema.join(', ')}`);
	}

	const definitions: Definition[] = [];
	for (const file of files) {
		definitions.push(...collectDefinitions(await environment.importModule(file) as Record<string, unknown>));
	}

	return {configFile, config, snapshot: buildSnapshot(definitions, config.casing)};
}

/** Reads the migration files newest first, one at a time. */
function* newestFirst(files: readonly string[]): Generator<string> {
	for (const file of files.toReversed()) {
		yield readFileSync(file, 'utf8');
	}
}

function pendingStatements(environment: CliEnvironment, project: Project): string[] {
	const files = migrationFiles(path.resolve(environment.cwd, project.config.out));
	return diff(latestState(newestFirst(files)) ?? emptyState, project.snapshot);
}

/** The migration file drizzle-kit just created, if it is the last one the migrator will apply. */
function createdMigration(before: readonly string[], after: readonly string[]): {file: string; isLast: boolean} {
	const created = after.filter(file => !before.includes(file));
	if (created.length !== 1) {
		throw new Error(`Expected drizzle-kit to create one migration, found ${created.length}`);
	}

	const [file] = created as [string];
	return {file, isLast: after.at(-1) === file};
}

// Drizzle Kit 1.0 names migration folders by the second, and the migrator sorts them by name, so ours can
// land in the same second as the schema migration before it and sort first. Then try again a second later.
const attempts = 3;

async function generate(environment: CliEnvironment, project: Project, name: string): Promise<number> {
	const statements = pendingStatements(environment, project);
	if (statements.length === 0) {
		environment.print('No function or trigger changes, nothing to generate.');
		return 0;
	}

	const outFolder = path.resolve(environment.cwd, project.config.out);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const before = migrationFiles(outFolder);
		const status = environment.runDrizzleKit(['generate', '--custom', `--name=${name}`, `--config=${project.configFile}`]);
		if (status !== 0) {
			environment.printError(`drizzle-kit generate --custom failed with exit code ${status}`);
			return status;
		}

		const {file, isLast} = createdMigration(before, migrationFiles(outFolder));
		if (isLast) {
			writeFileSync(file, renderMigration(statements, toState(project.snapshot)));
			environment.print(`Wrote ${statements.length} ${statements.length === 1 ? 'statement' : 'statements'} to ${path.relative(environment.cwd, file)}`);
			return 0;
		}

		rmSync(path.dirname(file), {recursive: true, force: true});
		await environment.sleep(1000);
	}

	environment.printError(`Could not create a migration that sorts after the existing ones in ${attempts} attempts`);
	return 1;
}

function check(environment: CliEnvironment, project: Project): number {
	const statements = pendingStatements(environment, project);
	if (statements.length === 0) {
		environment.print('Functions and triggers match the migrations.');
		return 0;
	}

	environment.printError(`Functions or triggers changed without a migration. Run drizzle-triggers generate. Pending:\n\n${statements.join('\n\n')}`);
	return 1;
}

/** Runs the CLI with `argv` (without the node and script paths) and returns the exit code. */
export async function runCli(argv: readonly string[], environment: CliEnvironment): Promise<number> {
	try {
		const {values, positionals} = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				config: {type: 'string', short: 'c'},
				name: {type: 'string', default: 'triggers'},
				help: {type: 'boolean', short: 'h'},
			},
		});
		const [command] = positionals;
		if (values.help === true || command === undefined) {
			environment.print(usage);
			return command === undefined && values.help !== true ? 1 : 0;
		}

		if (!['generate', 'check', 'sql'].includes(command)) {
			environment.printError(`Unknown command ${command}\n\n${usage}`);
			return 1;
		}

		const project = await loadProject(environment, values.config);
		if (command === 'sql') {
			environment.print(idempotentStatements(project.snapshot).join('\n\n'));
			return 0;
		}

		return command === 'check' ? check(environment, project) : await generate(environment, project, values.name);
	} catch (error) {
		environment.printError(`drizzle-triggers: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
