"""DITTO_CFG_VERIFY=1: compute the batched CFG and the original two-pass form
on the same real inputs and report the largest disagreement, so 'identical
arithmetic' is a measurement rather than a claim."""
import os, shutil, sys

p = os.path.expanduser("~/ditto-talkinghead/core/models/modules/lmdm_modules/model.py")
s = open(p).read()
if "carfox: verify" in s:
    print("already patched")
    sys.exit(0)

old = """        unc, conditioned = out[:b], out[b:]

        return unc + (conditioned - unc) * guidance_weight"""

new = """        unc, conditioned = out[:b], out[b:]

        if os.environ.get("DITTO_CFG_VERIFY") == "1":  # carfox: verify
            ref_u = self.forward(x, cond_frame, cond_embed, times, cond_drop_prob=1)
            ref_c = self.forward(x, cond_frame, cond_embed, times, cond_drop_prob=0)
            du = (ref_u - unc).abs().max().item()
            dc = (ref_c - conditioned).abs().max().item()
            scale = max(ref_c.abs().max().item(), 1e-9)
            print(f"CFG-VERIFY max|d_unc|={du:.3e} max|d_cond|={dc:.3e} "
                  f"rel={max(du, dc)/scale:.3e}", flush=True)

        return unc + (conditioned - unc) * guidance_weight"""

assert s.count(old) == 1, f"count {s.count(old)}"
s = s.replace(old, new, 1)
if "\nimport os" not in s and not s.startswith("import os"):
    s = "import os\n" + s
open(p, "w").write(s)
print("PATCHED: CFG verification branch")
