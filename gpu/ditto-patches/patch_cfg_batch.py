"""Run classifier-free guidance as ONE batch of 2 instead of two passes.

py-spy showed the whole render path idle and audio2motion (the LMDM diffusion)
as the only busy stage, with the GPU at 48% -- i.e. launch-bound, not
compute-bound. guided_forward was doing two sequential transformer passes per
ddim step, one unconditional and one conditioned. They are independent, so
stacking them on the batch axis is the same arithmetic with half the launches.

cond_drop_prob only ever reaches the model as a per-sample keep_mask (all-False
for the unconditional pass, all-True for the conditioned one), so the batched
call passes that mask explicitly.
"""
import os, shutil, sys

p = os.path.expanduser("~/ditto-talkinghead/core/models/modules/lmdm_modules/model.py")
if not os.path.exists(p + ".orig"):
    shutil.copy(p, p + ".orig")

s = open(p).read()
if "carfox: one batch of 2" in s:
    print("already patched")
    sys.exit(0)

old_guided = """    def guided_forward(self, x, cond_frame, cond_embed, times, guidance_weight):
        unc = self.forward(x, cond_frame, cond_embed, times, cond_drop_prob=1)
        conditioned = self.forward(x, cond_frame, cond_embed, times, cond_drop_prob=0)

        return unc + (conditioned - unc) * guidance_weight"""

new_guided = """    def guided_forward(self, x, cond_frame, cond_embed, times, guidance_weight):
        # carfox: one batch of 2 rather than two sequential passes. Same
        # weights, same inputs, same arithmetic -- the unconditional and
        # conditioned passes are independent, and this stage was launch-bound.
        b = x.shape[0]
        keep = torch.cat([
            torch.zeros(b, dtype=torch.bool, device=x.device),
            torch.ones(b, dtype=torch.bool, device=x.device),
        ], 0)
        out = self.forward(
            torch.cat([x, x], 0),
            torch.cat([cond_frame, cond_frame], 0),
            torch.cat([cond_embed, cond_embed], 0),
            torch.cat([times, times], 0),
            keep_mask=keep,
        )
        unc, conditioned = out[:b], out[b:]

        return unc + (conditioned - unc) * guidance_weight"""

assert s.count(old_guided) == 1, f"guided_forward count {s.count(old_guided)}"
s = s.replace(old_guided, new_guided, 1)

old_sig = """        self, x: Tensor, cond_frame: Tensor, cond_embed: Tensor, times: Tensor, cond_drop_prob: float = 0.0
    ):"""
new_sig = """        self, x: Tensor, cond_frame: Tensor, cond_embed: Tensor, times: Tensor, cond_drop_prob: float = 0.0,
        keep_mask=None,
    ):"""
assert s.count(old_sig) == 1, f"signature count {s.count(old_sig)}"
s = s.replace(old_sig, new_sig, 1)

old_mask = """        keep_mask = prob_mask_like((batch_size,), 1 - cond_drop_prob, device=device)"""
new_mask = """        if keep_mask is None:
            keep_mask = prob_mask_like((batch_size,), 1 - cond_drop_prob, device=device)"""
assert s.count(old_mask) == 1, f"keep_mask count {s.count(old_mask)}"
s = s.replace(old_mask, new_mask, 1)

open(p, "w").write(s)
print("PATCHED: CFG batched into one forward")
