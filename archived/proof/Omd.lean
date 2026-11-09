/-
The proof root. Every module below is part of the correctness argument for the
`omd` kernel: first the semantics `dsh` actually implements, then the kernel
composition and our own plugins built on those semantics.

Source correspondence lives in `proof/README.md`; each module's docstring names
the file it abstracts and what it leaves outside the model.
-/
import Omd.Basic
import Omd.Cordis.Effect
import Omd.Cordis.Fiber
import Omd.Cordis.Registry
import Omd.Cordis.Dispatch
import Omd.Dsh.Session
import Omd.Dsh.Prompt
import Omd.Dsh.Request
import Omd.Dsh.Tools
import Omd.Kernel.Spec
import Omd.Kernel.Generated
import Omd.Kernel.Composition
import Omd.Kernel.Facts
import Omd.Plugins.Contract
