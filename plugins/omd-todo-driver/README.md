# omd-todo-driver

Judge-gated todo continuation. When a turn stops while an active todo entry is
still runnable, and the judge says the stop is neither a wait nor completion,
the driver steers one more step into the same turn.

## Form

One trigger, `agent/turn-stopping`. The loop dispatches it after the last step
and before `turn/end`, only when the model was already going to stop and the
inbox holds no next-step input. Aborts and model errors never reach it, so the
driver does not have to tell "stopped" from "interrupted".

A hit is one `agent.steer` of a user message with
`source.kind === 'omd-todo-nudge'`. It is not `inject`: a nudge asks for another
step now, while injected context waits for a future turn. The message names the
first active entry with its tree path, its goal, and a readable address
(`dsh-resource://todo/current/<path>`), then leaves the exit open: say in the
reply when the agent is waiting on a background job, a child agent, or a human
answer. The driver never writes the next step for the model.

At the consecutive cap it injects one `form: 'notice'` message instead, saying
that the loop stopped and a human word or a todo change reopens it. A notice is
injected, not steered: it asks the model to stop, and it must not spend a step.

## Gates

Every gate below resolves to "do not nudge". Only the judge is semantic; the
rest are structural and never call a model.

| Gate | Rule |
|---|---|
| Disabled | `enabled` is false at the stop boundary. |
| No work | No entry has `state === 'active'`. Inactive and completed entries are normal completion, not a nudge case. |
| Manual stop | The newest `turn/end` is `aborted` + `reason.kind === 'user'` and no human message follows it. Only `source.kind === 'user'` unlatches; a job notice, a cron reminder, or a subagent report is not a human taking control back. |
| Inbox busy | `inbox.nextStep` or `inbox.nextTurn` is non-empty before and after the judge call: someone already queued work (job notice, subagent result, `/loop`, human message). |
| Consecutive cap | `nudges >= maxConsecutive` since the latest `todo/write`; the cap notice is written once per list write. |
| Cooldown | Less than `cooldownMs` since the newest admitted nudge. |
| Subagent session | `session.header.origin === 'subagent'` is never nudged. A forked user session is. |
| Judge unavailable | `judge.available()` is false, the call throws, or the answer is not a `choice`. No mechanical fallback: the driver does not read sentences and does not guess. |
| Low confidence | The verdict is `continue` only at `confidence >= minConfidence`; `wait`, `done`, and low confidence all mean no nudge. |

### Why `minConfidence` defaults to 0.45

The verdict is a three-way choice (`continue` / `wait` / `done`) with a full
probability distribution. A flat distribution puts each label at 0.333, so the
usable range above chance is narrow.

The original default of 0.75 demanded near-certainty from a soft three-way
distribution and in practice closed the feature. On one stop the judge returned
`continue` at 0.46 and on another at 0.7201; both were refused. A different stop
returned `done` 0.458 / `continue` 0.362 — the top label was `done`, so no nudge
was correct there regardless of threshold.

0.45 sits above the 0.333 uniform value and below the `continue` answers
actually observed (0.46–0.72). That is what "`continue` is the leading
hypothesis by a margin" means for this judge. It is a default, not a stance: the
key stays volatile and a host that wants a stricter gate can raise it.

The cost of a wrong nudge is bounded — at most `maxConsecutive` extra steps and
one notice per `todo/write` — while a threshold nobody can reach costs the whole
feature.

Two measured verdicts on this host, both from the `todo-continuation` question
with a single active entry and nothing waiting:
`continue` 0.771 / `wait` 0.095 / `done` 0.134, and
`continue` 0.5339 / `wait` 0.2058 / `done` 0.2602. The second one nudged at
0.45 and the old 0.75 would have refused it, on the same shape of stop and the
same question.

## Judge input

The state is assembled by `omd-judge-context`, one package shared by every
judge line; this driver passes the todo tree and the three wait facts. The
recipe is fixed:

1. Constant task text — carried as the choice question's `instructions`, not
   inside the state. `omd-judgment` owns its system prompt; the task is stable
   across calls, so the prefix stays cacheable.
2. The active todo tree with `state`, `goal`, and an `explanation` excerpt. The
   tree keeps hierarchy, caps at 30 nodes, and reports `todo_omitted`.
3. The last human message, clipped to 800 characters.
4. The three newest assistant messages, clipped to 600 characters each.
5. Tool history with the remaining budget: calls without a result and
   `isError` results first, newest first, then clean calls, newest first. When
   the budget runs out the state says how many older calls were left out.

The three wait facts — running background jobs owned by this session, running
children of this session, unanswered `ask_user_question` calls — ride along as
a small `waiting` object. They are inputs to the verdict, not storage.

Priority when over budget: tool history goes first, then assistant messages,
then the human message; the task and todo tree are cut last. Default budget is
`judgeBudgetTokens: 4000`.

The verdict is a `choice` (`continue` / `wait` / `done`) plus a full
probability distribution. The driver logs the distribution as the reason:
`omd-judgment` returns no free text, and inventing a second judge contract here
would be a second implementation. Parse failure, timeout, unavailable service,
and low confidence all behave like `wait`.

## State: folded from the session log

There is no event type, no storage domain, and no in-memory state that a
restart would lose. A per-session `WeakMap` fold starts from
`session.snapshotEvents()` on first use and then follows `session/event`:

- nudges after the latest `todo/write` (`source.kind === 'omd-todo-nudge'`,
  noticing excluded);
- the newest nudge's `time`, which is the cooldown anchor;
- whether a cap notice was already written since that write;
- the manual-stop latch: newest `aborted` + `user` turn end versus the newest
  human message.

The count uses **admitted** messages, not `steer` calls, because admission is
what means the model actually saw the nudge.

Restart: the same log folds to the same counters and the same latch.
Fork: the child inherits the whole parent prefix, so a parent that already hit
the cap or was manually stopped starts the child stopped. The first human
message or the first `todo/write` in the child reopens it. This is the
conservative choice: a fresh child never resumes nudging on inherited evidence.

## `wakeOnExternalTodoChange`

Default `false`, and the default is a stance, not an omission. The v1 trigger
is the stop boundary: an external writer that changes the todo list while the
agent is idle does not start a turn, because starting one without a human word
is a different kind of authority than continuing a turn the human already
started.

Set it to `true` and the driver subscribes to the todo data plane for each
non-subagent agent it sees created. When an idle agent's list changes, a 250 ms
debounce lets a batch of file/issue writes settle, then the same gates and
judge run and a `continue` verdict enters through `agent.followup` — a new
turn, never a steer into a turn that does not exist. It is not an
`agent/status` trigger: the todo data plane says what changed, and `agent.status`
is only consulted to confirm the agent is idle. A model's own write during a
turn is ignored because the agent is running at that moment.

A host without `omd-judgment` still mounts this plugin. Every stop then passes
the structural gates and finds no judge, so nothing is sent: the plugin
declares no hard service dependency and reads the judge through `ctx.get`.

## Config

| Key | Default | Volatile | Meaning |
|---|---|---|---|
| `enabled` | `true` | yes | Master switch. |
| `maxConsecutive` | `3` | yes | Nudges after one `todo/write` before the notice. |
| `cooldownMs` | `5000` | yes | Minimum gap between nudges. |
| `wakeOnExternalTodoChange` | `false` | no | External-change follow-up (above). |
| `minConfidence` | `0.45` | yes | Continue confidence needed to nudge; derivation under Gates. |
| `judgeBudgetTokens` | `4000` | yes | Budget of the assembled judge state. |

## Model Experience

The nudge is the only model-visible addition, and only on a stop that passed
every gate. It is one user message appended after the existing prefix, with a
fixed template whose variable parts are the entry path, text, and goal. The
prefix and tool schemas do not change, so KV cache reuse is unaffected up to the
append point. At most `maxConsecutive` nudges and one notice are added per
`todo/write`, so a misjudging judge costs at most that many extra steps. The
judge call itself uses a separate, bounded request (default 4000 state tokens)
and never carries the system prompt, tool schemas, spill bodies, or images.

## Known Limitations and Deferred Work

- The verdict has no free-text reason. The log carries the full distribution
  instead; a free-text reason would require changing `omd-judgment`'s result
  contract.
- The cap notice is injected, so a session that is never woken again may never
  show it to the model. The latch is still recorded in the log.
- A fork inherits the parent's counters and latch until the first human message
  or `todo/write`; there is no `inheritedEventCount` cut in this slice.
- Two triggers can race (this driver and another `agent/turn-stopping` listener
  both steering); the model sees two "continue" messages pointing at the same
  work, which is accepted rather than locked.
- `wakeOnExternalTodoChange` subscribes per created agent. It has no session
  enumeration of its own, so an external writer targeting a session that has no
  live agent has nothing to wake.
