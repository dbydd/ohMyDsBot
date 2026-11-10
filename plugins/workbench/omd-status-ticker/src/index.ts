/**
 * Node half of the status ticker. It has no host behaviour: the browser half in
 * `src/client/` owns every contribution, and this entry exists only so the
 * package appears as an ordinary Loader row — the client module table attaches
 * a package's browser half to the row whose specifier is the bare package name
 * (`docs/subsystems/client-modules.md`), and a row with no importable entry
 * never becomes live.
 *
 * Nothing here writes session events, registers a source, or reads config.
 *
 * @module omd-status-ticker
 */

/** Loader-visible no-op body. */
export function apply(): void {}
