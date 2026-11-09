# omd-judge-context

The one budgeted context assembler every judge line shares. A library, not a
mounted plugin.

A judge call is only as good as the material it sees, and two hand-written
assemblers always drift. This package owns the fixed priority: constant task
text, active todo state, the last human message, the three newest assistant
messages, and the tool history that fits the remaining budget. Callers supply
the session and the facts they already own; the package reads the log.

## Use

```ts
import { buildJudgeContext, TODO_CONTINUATION_TASK } from 'omd-judge-context'

const context = await buildJudgeContext(ctx, {
  session: agent.session,
  budget: 4000,
  purpose: 'todo-continuation',
  facts: {
    todos: [{ path: '2', content: '写 b.txt', state: 'active', goal: 'b.txt 里有那句话' }],
    waiting: { jobs: [], children: [], user_questions: [] },
  },
})
// context.task  -> constant question instructions
// context.state -> the only material the verdict may rest on
```

`buildJudgeContext` reads through `ctx.sessionQuery.readSession`, which returns
the live-preferred log as it stands. The asynchronous read is the only ambient
dependency; `assembleJudgeContext` is pure and takes the header and events
directly.

## Sections and budget

1. Task text — outside the state, carried as the judge question's instructions.
2. Todo tree — hierarchy preserved, 30-node cap, `todo_omitted` reports cuts.
3. Last human message — 800 characters.
4. Three newest assistant messages — 600 characters each, oldest first.
5. Tool history — remaining budget, abnormal calls first (no result, `isError`),
   newest first, then clean calls; `omitted_tool_calls` and a plain note report
   the tail that did not fit.

Over budget, the ladder drops tool history, then assistant messages, then the
human message, then trims the todo tree — the task and the todo tree are cut
last. The state never carries the system prompt, tool schemas, spill bodies, or
image bytes.

`estimateTokens` counts ASCII at four characters per token and every other code
point as one token; it is the same estimator the budget uses, so callers can
reason about `context.tokens` without a tokenizer dependency.

## Purposes

`todo-continuation` has a built-in task. Another line (for example a
visualization judge) either adds its constant task to `DEFAULT_TASKS` here — one
shared place — or passes `task` explicitly. The package assembles context; it
does not invent a verdict contract for a purpose it does not know.

## Known Limitations

- No tokenizer: the estimator is a conservative approximation, not a model's
  exact count.
- The session read clones the full log per call. That is deliberate for a stop
  boundary (the log must be current), but a caller judging every message should
  budget the read cost too.
- Tool arguments and results are clipped to 160 characters each; the full text
  stays in the session log for anyone who needs it.
