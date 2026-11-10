/**
 * Bridge layer between dsh tool invocation and core executeAction / executeToolInput.
 *
 * @module omd-hindsight/ops
 */

export { executeAction, executeToolInput, backingMentalModelId } from './core/ops.ts'
export type { ActionOutcome, ActionSuccess, ToolOutcome } from './core/ops.ts'
export { renderOutcome } from './core/render.ts'
