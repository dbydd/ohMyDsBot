/**
 * Pure parsing, section splitting, and section replacement for the two-part
 * markdown working-memory notebook.
 *
 * Contract:
 * - A level-one heading is a line starting with `#` followed by space or tab,
 *   OUTSIDE fenced code blocks (``` or ~~~).
 * - The first actual level-one heading and its section (everything up to the
 *   second level-one heading) is shared and editable by both human and model.
 * - The second actual level-one heading onward is agent notes (human UI read-only).
 * - Reasonable empty initial content: `# Shared\n\n# Agent notes\n`.
 * - Existing notebook data without structure preserves contents in the agent portion
 *   rather than discarding it.
 *
 * @module omd-context-notes/markdown
 */

export interface ParsedNotebook {
  /** Text before the first level-one heading (if any). */
  readonly preamble: string
  /** The first level-one heading line (e.g. "# Shared"). Empty if none found. */
  readonly sharedHeading: string
  /** Content of the shared section (excluding heading line). */
  readonly sharedBody: string
  /** The full shared section: heading + body. */
  readonly sharedSection: string
  /** The second level-one heading and everything after it. Empty if none found. */
  readonly agentSection: string
  /** Whether the document had at least one level-one heading. */
  readonly structured: boolean
}

export const DEFAULT_NOTEBOOK = '# Shared\n\n# Agent notes\n'

/**
 * Split markdown text into its shared section and agent-private section,
 * ignoring heading-like lines inside fenced code blocks.
 *
 * @param markdown - the full notebook markdown text.
 * @returns parsed sections.
 */
export function parseNotebook(markdown: string): ParsedNotebook {
  if (markdown.trim() === '') {
    return {
      preamble: '',
      sharedHeading: '# Shared',
      sharedBody: '',
      sharedSection: '# Shared',
      agentSection: '# Agent notes',
      structured: false,
    }
  }

  const lines = markdown.split(/\r?\n/u)
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0

  const h1Indices: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trimStart()

    // Check for code fence start/end: ``` or ~~~ (at least 3 characters)
    const match = trimmed.match(/^(`{3,}|~{3,})/u)
    if (match) {
      const matchFence = match[1]!
      const char = matchFence[0]!
      const len = matchFence.length

      if (!inFence) {
        inFence = true
        fenceChar = char
        fenceLength = len
      } else if (char === fenceChar && len >= fenceLength) {
        inFence = false
        fenceChar = ''
        fenceLength = 0
      }
      continue
    }

    if (!inFence) {
      // Check for level-one heading: `#` followed by whitespace (and not `##`)
      if (/^#[ \t]+.*$/u.test(trimmed)) {
        h1Indices.push(i)
      }
    }
  }

  // Safe migration: if not structured (no level-one headings found),
  // preserve existing unstructured content in the agent portion.
  if (h1Indices.length === 0) {
    return {
      preamble: '',
      sharedHeading: '# Shared',
      sharedBody: '',
      sharedSection: '# Shared',
      agentSection: `# Agent notes\n\n${markdown}`,
      structured: false,
    }
  }

  const firstH1 = h1Indices[0]!
  const preamble = lines.slice(0, firstH1).join('\n')

  if (h1Indices.length === 1) {
    const heading = lines[firstH1]!
    const body = lines.slice(firstH1 + 1).join('\n')
    const section = lines.slice(firstH1).join('\n')
    return {
      preamble,
      sharedHeading: heading,
      sharedBody: body,
      sharedSection: section,
      agentSection: '# Agent notes',
      structured: true,
    }
  }

  // 2 or more level-one headings
  const secondH1 = h1Indices[1]!
  const heading = lines[firstH1]!
  const body = lines.slice(firstH1 + 1, secondH1).join('\n')
  const sharedSection = lines.slice(firstH1, secondH1).join('\n')
  const agentSection = lines.slice(secondH1).join('\n')

  return {
    preamble,
    sharedHeading: heading,
    sharedBody: body,
    sharedSection,
    agentSection,
    structured: true,
  }
}

/**
 * Replace only the shared section of a notebook while preserving the agent section
 * and any preamble. If the document is unstructured, content is safely migrated.
 *
 * @param currentFullText - existing full notebook text.
 * @param newSharedText - replacement text for the shared portion. Can either start
 *   with `# Heading` or be raw body text (which will retain the existing shared heading).
 * @returns the spliced full markdown document.
 */
export function updateSharedSection(currentFullText: string, newSharedText: string): string {
  const parsed = parseNotebook(currentFullText)
  const trimmedNew = newSharedText.trim()

  let finalShared: string
  if (trimmedNew.startsWith('# ')) {
    finalShared = trimmedNew
  } else {
    const heading = parsed.sharedHeading || '# Shared'
    finalShared = trimmedNew === '' ? heading : `${heading}\n\n${trimmedNew}`
  }

  const parts: string[] = []
  if (parsed.preamble.trim() !== '') {
    parts.push(parsed.preamble.trimEnd())
  }
  parts.push(finalShared.trimEnd())

  const agent = parsed.agentSection.trim()
  if (agent !== '') {
    parts.push(agent)
  } else {
    parts.push('# Agent notes')
  }

  return parts.join('\n\n') + '\n'
}

/**
 * Replace only the agent section of a notebook while preserving the shared section
 * and any preamble.
 *
 * @param currentFullText - existing full notebook text.
 * @param newAgentText - replacement text for the agent portion.
 * @returns the spliced full markdown document.
 */
export function updateAgentSection(currentFullText: string, newAgentText: string): string {
  const parsed = parseNotebook(currentFullText)
  const trimmedNew = newAgentText.trim()

  let finalAgent: string
  if (trimmedNew.startsWith('# ')) {
    finalAgent = trimmedNew
  } else {
    finalAgent = trimmedNew === '' ? '# Agent notes' : `# Agent notes\n\n${trimmedNew}`
  }

  const parts: string[] = []
  if (parsed.preamble.trim() !== '') {
    parts.push(parsed.preamble.trimEnd())
  }
  parts.push(parsed.sharedSection.trimEnd())
  parts.push(finalAgent.trimEnd())

  return parts.join('\n\n') + '\n'
}

function findChildSectionRange(
  lines: string[],
  childId: string,
): { start: number; end: number; title: string } | undefined {
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0

  const targetMarker = `<!-- section:${childId} -->`
  const targetMarkerAlt = `<!-- section: ${childId} -->`
  const idBracket = `[${childId}]`
  const idParen = `(${childId})`

  let foundStart = -1
  let foundTitle = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trimStart()

    const match = trimmed.match(/^(`{3,}|~{3,})/u)
    if (match) {
      const matchFence = match[1]!
      const char = matchFence[0]!
      const len = matchFence.length
      if (!inFence) {
        inFence = true
        fenceChar = char
        fenceLength = len
      } else if (char === fenceChar && len >= fenceLength) {
        inFence = false
        fenceChar = ''
        fenceLength = 0
      }
      continue
    }

    if (inFence) continue

    const isSubsectionStart =
      trimmed.startsWith('<!-- section:') ||
      /^##[ \t]+/u.test(trimmed) ||
      /^#[ \t]+/u.test(trimmed)

    if (foundStart >= 0 && i > foundStart) {
      const isMarkerHeader = (i === foundStart + 1) && /^##[ \t]+/u.test(trimmed)
      if (isSubsectionStart && !isMarkerHeader) {
        return { start: foundStart, end: i, title: foundTitle }
      }
    }

    if (foundStart < 0) {
      if (trimmed === targetMarker || trimmed === targetMarkerAlt) {
        foundStart = i
        if (i + 1 < lines.length && /^##[ \t]+/u.test(lines[i + 1]!.trimStart())) {
          foundTitle = lines[i + 1]!.trimStart().replace(/^##[ \t]+/u, '').trim()
        }
      } else if (/^##[ \t]+/u.test(trimmed) && (trimmed.includes(idBracket) || trimmed.includes(idParen) || trimmed.includes(childId))) {
        foundStart = i
        foundTitle = trimmed.replace(/^##[ \t]+/u, '').replace(idBracket, '').replace(idParen, '').trim()
      }
    }
  }

  if (foundStart >= 0) {
    return { start: foundStart, end: lines.length, title: foundTitle }
  }
  return undefined
}

export function getChildSection(currentFullText: string, childId: string): string | undefined {
  const parsed = parseNotebook(currentFullText)
  const lines = parsed.agentSection.split(/\r?\n/u)
  const range = findChildSectionRange(lines, childId)
  if (!range) return undefined
  return lines.slice(range.start, range.end).join('\n').trim()
}

export function updateChildSection(
  currentFullText: string,
  childId: string,
  title: string,
  newSectionContent: string,
): string {
  const parsed = parseNotebook(currentFullText)
  const lines = parsed.agentSection.split(/\r?\n/u)
  const range = findChildSectionRange(lines, childId)

  const cleanContent = newSectionContent.trim()
  let replacement: string
  if (cleanContent.startsWith('## ')) {
    replacement = `<!-- section:${childId} -->\n${cleanContent}`
  } else {
    const heading = title ? `## ${title}` : `## Child ${childId}`
    replacement = cleanContent === ''
      ? `<!-- section:${childId} -->\n${heading}`
      : `<!-- section:${childId} -->\n${heading}\n\n${cleanContent}`
  }

  let newAgentSection: string
  if (range) {
    lines.splice(range.start, range.end - range.start, replacement)
    newAgentSection = lines.join('\n')
  } else {
    newAgentSection = parsed.agentSection.trimEnd() + `\n\n${replacement}\n`
  }

  return updateAgentSection(currentFullText, newAgentSection)
}
