/**
 * `omd-workbench` — host half.
 *
 * The workbench is browser chrome: the Client half draws the top bar and
 * reserves its height on `#root`. This half exists so the package mounts as an
 * ordinary profile plugin and its Client module lands in the boot manifest.
 *
 * @module omd-workbench
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name for registration in Cordis. */
export const name = 'omd-workbench'

/**
 * No Host services are used. The empty apply keeps the fiber active.
 * @param _ctx - Host context; unused.
 */
export function apply(_ctx: Context): void {}
