# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Schema files that import through tsconfig `paths` aliases now load. The CLI reads `paths` and `baseUrl` from your tsconfig.json, including configs it `extends`, so you no longer need to repeat them in `JITI_ALIAS`. Aliases set in `JITI_ALIAS` still apply and take precedence. ([#6](https://github.com/RagedPanda/drizzle-triggers/pull/6) by [@Wonkers0](https://github.com/Wonkers0), with the `JITI_ALIAS` and package `extends` follow-ups by [@RagedPanda](https://github.com/RagedPanda))

## [0.1.1] - 2026-10-31

### Changed

- Releases are now published from GitHub Actions with npm provenance, so you can check that each version on npm was built from this repository. There are no code changes since 0.1.0.

## [0.1.0] - 2026-10-31

### Added

- `pgFunction()` and `pgTrigger()` define Postgres functions and triggers next to your Drizzle tables, with type-checked `NEW`/`OLD` columns in `when` conditions.
- `updatedAtTrigger()` keeps an `updatedAt` column current for every update, including the ones that don't go through Drizzle.
- `drizzle-triggers generate` writes only what changed into a Drizzle Kit custom migration, so `drizzle-kit migrate` applies it in order with your other migrations.
- `drizzle-triggers check` fails CI when a definition changed without a migration, and `drizzle-triggers sql` prints the SQL for every definition.
- `applyDefinitions()` sets up functions and triggers without migrations, for tests and `drizzle-kit push` setups.
- Works with Drizzle ORM 0.36.4 and later, including 1.0, in ESM and CommonJS projects.

[unreleased]: https://github.com/RagedPanda/drizzle-triggers/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/RagedPanda/drizzle-triggers/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RagedPanda/drizzle-triggers/releases/tag/v0.1.0
