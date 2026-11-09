/**
 * omd-core — the oh-my-dsh host layer as a profile bundle. The package's
 * substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch` manifest
 * field and resolved by the profile composer through that field; this module
 * carries no runtime API.
 *
 * The layer holds everything that is true about the harness regardless of
 * which front end is attached: model routing, and the host half of each
 * capability this repository adds. The `omd` profile stacks it first and then
 * the web application bundle.
 * @module omd-core
 */

export {}
