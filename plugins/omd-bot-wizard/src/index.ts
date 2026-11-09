/**
 * `omd-bot-wizard` — host half.
 *
 * The wizard is entirely a browser concern: the Client half holds DS-Bot's
 * `create-bot` request, asks the two questions DS-Bot's create dialog has no
 * field for, and forwards the same request with the answers folded into
 * `instructions`. This half exists only so the package mounts as an ordinary
 * profile plugin; mounting it is what puts the Client module in the boot
 * manifest.
 *
 * Nothing here registers a service, a tool, or a session event: the answers
 * land in the Bot record through the endpoint DS-Bot already owns.
 *
 * @module omd-bot-wizard
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name for registration in Cordis. */
export const name = 'omd-bot-wizard'

/**
 * No Host services are used. The empty apply keeps the fiber active so the
 * package counts as a mounted Client module.
 * @param _ctx - Host context; unused.
 */
export function apply(_ctx: Context): void {}
