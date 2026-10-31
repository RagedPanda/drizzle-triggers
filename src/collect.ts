import {isFunctionDefinition, isTriggerDefinition, type Definition} from './definitions.ts';

/**
 * The function and trigger definitions among a module's exports, such as `await import('./schema.ts')`.
 * Arrays and plain objects are searched one level deep, so `export const triggers = [a, b]` works too.
 */
export function collectDefinitions(moduleExports: Readonly<Record<string, unknown>>): Definition[] {
	const definitions = new Set<Definition>();
	const add = (value: unknown) => {
		if (isFunctionDefinition(value) || isTriggerDefinition(value)) {
			definitions.add(value);
		}
	};

	for (const value of Object.values(moduleExports)) {
		add(value);
		if (Array.isArray(value)) {
			value.forEach(add);
		} else if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
			Object.values(value).forEach(add);
		}
	}

	return [...definitions];
}
