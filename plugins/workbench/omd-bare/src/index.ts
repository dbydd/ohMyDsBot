/**
 * `omd-bare` — host half.
 *
 * The bare shell is a browser concern: the Client half zeroes the frame's side
 * columns. This half exists so the package mounts as a profile plugin.
 *
 * @module omd-bare
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name for registration in Cordis. */
export const name = 'omd-bare'

/**
 * No Host services are used.
 * @param _ctx - Host context; unused.
 */
export function apply(_ctx: Context): void {}
