/-
The kernel's correctness predicates, and the classification of composed rows.

`Omd/Kernel/Generated.lean` holds the data (the composed rows, extracted from the
real profile by `scripts/extract.mjs`); this file holds the statements those rows
are checked against. Nothing here is specific to a particular run: the data
changes, the predicates do not.

The assignment `env` fixes which platform atoms count as true when the facts are
checked. `Cond.eval` reads an absent atom as `false`, so `env` describes the
non-Windows, no-authoring-runtime environment. A port re-runs the extractor and
re-checks the same predicates under that platform's assignment; the facts are
about the composition, they are not portable by assumption.
-/
import Omd.Basic

namespace Omd.Kernel

/-- The platform assignment the kernel facts are checked under.

`win32` is the only atom the composition's guards test directly. The authoring
runtime and office-CLI atoms read as `false` because they are absent, which is
the branch where those rows stay disabled. -/
def env : List (String × Bool) := [("win32", false)]

/-- Rows that exist only to serve a human: they wait for a typed answer, a review,
a permission decision, or a panel.

Every id here is a row of `@deepseek-ai/dsh-base`. The kernel disables all of
them by id in `profiles/omd-kernel/cordis.patch.yml`. -/
def rowsThatNeedAHuman : List String :=
  [ "user-questions"
  , "commands"
  , "command-feedback"
  , "command-compact"
  , "command-goal"
  , "plan-mode"
  , "approval"
  , "permission"
  , "settings"
  , "config-editor"
  , "session-title"
  , "session-title-llm"
  , "plugin-manager"
  , "tool-plugin-manager"
  ]

/-- Rows whose configuration or credentials exist only on one machine.

`llm-pi-ai` reads `$DSH_HOME/models.yml`; `deepseek-account` and
`llm-deepseek-account` need a browser login. A kernel composes neither: the SDK
client names its route at `initialize`, and the route resolves through the base
API-key adapter. -/
def rowsBoundToThisMachine : List String :=
  [ "llm-pi-ai", "deepseek-account", "llm-deepseek-account" ]

/-- The rows that are the external manipulation surface.

`sdk-app-startup` owns the zero-option command provider and `sdk-jsonrpc-server`
serves newline-delimited JSON-RPC on stdio. The rest are the services that
surface needs in order to answer `initialize` and run a turn. -/
def interfaceRows : List String :=
  [ "sdk-app-startup"
  , "sdk-jsonrpc-server"
  , "agent"
  , "agent-loop"
  , "session"
  , "llm"
  , "tools"
  , "system-prompt"
  ]

/-- The enabled rows, in composition order. -/
def enabledRows (asg : List (String × Bool)) (l : List Entry) : List Entry :=
  l.filter fun e => e.enabled asg

/-- The ids of the enabled rows. -/
def enabledIds (asg : List (String × Bool)) (l : List Entry) : List String :=
  (enabledRows asg l).map (·.id)

/-- Every enabled row has all of its required services provided by an enabled row.

This is the composition-level statement of "no entry is left waiting forever":
combined with activation (see `Omd.Cordis.Fiber`), it is what makes the mounting
order irrelevant for the kernel. -/
def closed (asg : List (String × Bool)) (l : List Entry) : Bool :=
  l.all fun e => !e.enabled asg || e.requires.all (provided asg l)

/-- No service key has two enabled providers. -/
def uniqueProvider (asg : List (String × Bool)) (l : List Entry) : Bool :=
  l.all fun e => l.all fun f =>
    !e.enabled asg || !f.enabled asg || e.id == f.id ||
      e.provides.all fun k => !f.provides.contains k

/-- No row that needs a human is enabled. -/
def noHumanSurface (asg : List (String × Bool)) (l : List Entry) : Bool :=
  l.all fun e => !e.enabled asg || !rowsThatNeedAHuman.contains e.id

/-- No row bound to one machine's files or login is enabled. -/
def noMachineBinding (asg : List (String × Bool)) (l : List Entry) : Bool :=
  l.all fun e => !e.enabled asg || !rowsBoundToThisMachine.contains e.id

/-- Every row of the external manipulation surface is enabled. -/
def interfacePresent (asg : List (String × Bool)) (l : List Entry) : Bool :=
  interfaceRows.all fun i => (enabledRows asg l).any fun e => e.id == i

/-- The row carrying this id, when the composition has it. -/
def row (l : List Entry) (id : String) : Option Entry :=
  l.find? fun e => e.id == id

end Omd.Kernel
