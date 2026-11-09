/-
Proof-hygiene check: nothing in the development rests on `sorryAx`.
Run with `lake env lean generated/axioms.lean`.
-/
import Omd

open Omd

#print axioms Omd.Cordis.unwind_restores
#print axioms Omd.Cordis.unwind_order_is_reverse
#print axioms Omd.Cordis.closure_stable
#print axioms Omd.Cordis.schedule_reaches_closure
#print axioms Omd.Cordis.Registry.sibling_hidden_from_proxy_visible_to_get
#print axioms Omd.Cordis.Dispatch.waterfall_short_circuit
#print axioms Omd.Dsh.assemble_congr
#print axioms Omd.Dsh.step_inputs_logged
#print axioms Omd.Dsh.Prompt.merge_order_independent
#print axioms Omd.Dsh.Tools.guard_denial_irreversible
#print axioms Omd.Plugins.mount_preserves_closed
#print axioms Omd.Kernel.kernel_closed
#print axioms Omd.Kernel.kernel_topo
#print axioms Omd.Kernel.kernel_disjoint
#print axioms Omd.Kernel.kernel_stratified
#print axioms Omd.Kernel.kernel_no_pending
#print axioms Omd.Kernel.kernel_no_pending_status
#print axioms Omd.Kernel.kernel_unique
#print axioms Omd.Kernel.kernel_no_human
#print axioms Omd.Kernel.kernel_no_machine
#print axioms Omd.Kernel.kernel_interface
