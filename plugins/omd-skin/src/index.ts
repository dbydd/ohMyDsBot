/**
 * `omd-skin` — host half.
 *
 * The skin is entirely a browser concern: the Client half injects one
 * stylesheet and marks `html[data-omd-skin]`. This half exists only so the
 * package mounts as an ordinary profile plugin; mounting it is what puts the
 * Client module in the boot manifest.
 *
 * @module omd-skin
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name for registration in Cordis. */
export const name = 'omd-skin'

/**
 * No Host services are used. The empty apply keeps the fiber active so the
 * package counts as a mounted Client module.
 * @param _ctx - Host context; unused.
 */
export function apply(_ctx: Context): void {}
