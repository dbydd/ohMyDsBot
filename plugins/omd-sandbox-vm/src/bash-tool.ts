/**
 * The `bash` tool a sandboxed agent gets: same name, same arguments, same
 * result shape as the host's, with the command executed inside the machine
 * instead of on the host.
 *
 * It exists because the tool surface is the one thing an agent cannot be told
 * apart by: a coding agent that reads and writes through the host filesystem
 * and runs its commands in a Linux guest behaves exactly like one running
 * locally, which is what keeps the prompt and the transcript honest. The
 * machine name is captured here rather than taken from the arguments, so the
 * model cannot aim a command at another job's machine.
 *
 * @module omd-sandbox-vm/bash-tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SandboxExecResult, SandboxService } from './types.ts'

/** How one command's output is handed back. */
export interface SandboxBashOutput {
  /** Guest working directory the command ran in. */
  cwd: string
  /** Exit status, or null when a deadline or a cancellation ended the run. */
  exitCode: number | null
  /** Standard output followed by standard error, in that order. */
  output: string
  /** Whether the deadline ended the run before it finished. */
  timedOut: boolean
}

/** What the tool needs from its deployment. */
export interface SandboxBashOptions {
  /** The machine provider. */
  readonly vm: SandboxService
  /** Machine this agent's commands run in. */
  readonly machine: string
  /** Guest directory commands default to. */
  readonly workspacePath: string
  /** Ceiling applied when the model names no timeout. */
  readonly defaultTimeoutMs: number
  /** Largest output, in characters, kept before the tail is dropped. */
  readonly maxOutputChars: number
}

/** Description shown to the model: it names the machine, never the host. */
function describe(options: SandboxBashOptions): string {
  return [
    'Run a shell command in this session\'s isolated Linux environment.',
    '',
    `- Commands run inside machine \`${options.machine}\` (aarch64 Debian), not on the host that runs the assistant.`,
    `- The workspace is mounted at \`${options.workspacePath}\`; a relative workdir resolves against it.`,
    '- Files you read with `read` and change with `write`/`edit` are the same files this command sees: the workspace is one directory shared by both sides.',
    '- The environment has no access to the host filesystem outside the workspace, and no access to the host network stack beyond its own.',
    '- Standard output and standard error come back together, in that order.',
  ].join('\n')
}

/** Join both streams and keep the tail when the output is too large to return whole. */
function gather(result: SandboxExecResult, maxChars: number): { output: string; truncated: boolean } {
  const combined = result.stderr === '' ? result.stdout : `${result.stdout}${result.stderr}`
  if (combined.length <= maxChars) return { output: combined, truncated: false }
  const head = combined.slice(0, Math.floor(maxChars / 4))
  const tail = combined.slice(combined.length - (maxChars - head.length))
  return { output: `${head}\n… ${String(combined.length - maxChars)} characters omitted …\n${tail}`, truncated: true }
}

/**
 * Build the sandbox `bash` tool for one machine.
 * @param options - the provider, the machine, and the output bounds.
 * @returns a tool definition that registers under the name `bash`.
 */
export function createSandboxBash(options: SandboxBashOptions) {
  const defaultTimeout = options.defaultTimeoutMs

  return defineTool({
    name: 'bash',
    description: describe(options),
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command to execute.' },
      description: {
        type: 'string',
        description: 'Five to ten words, active voice, describing what the command does. Shown to the user.',
      },
      workdir: {
        type: 'string',
        description: `Working directory inside the machine. Defaults to ${options.workspacePath}; a relative path resolves against it.`,
      },
      timeoutMs: {
        type: 'number',
        description: `Deadline in milliseconds. Defaults to ${String(defaultTimeout)}; the command is killed when it expires.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          output: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
        },
      },
      render: (_args, value: SandboxBashOutput): ContentBlock[] => {
        const status = value.timedOut
          ? `killed after the deadline in ${value.cwd}`
          : `exit ${value.exitCode === null ? 'unknown' : String(value.exitCode)} in ${value.cwd}`
        return [{ type: 'text', text: `(${status})\n${value.output}` }]
      },
    },
    async execute(args, exec): Promise<SandboxBashOutput> {
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (command === '') throw new Error('command must be a non-empty string')
      const workdir = typeof args.workdir === 'string' && args.workdir.trim() !== '' ? args.workdir : options.workspacePath
      const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : defaultTimeout

      const result = await options.vm.exec(options.machine, command, {
        cwd: workdir,
        timeoutMs,
        signal: exec.signal,
      })
      const { output } = gather(result, options.maxOutputChars)
      return {
        cwd: workdir,
        exitCode: result.code ?? null,
        output,
        timedOut: result.outcome === 'timeout',
      }
    },
  })
}
