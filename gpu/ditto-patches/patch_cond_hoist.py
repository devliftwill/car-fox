"""Compute the audio conditioning ONCE per window instead of 20 times.

Measured context: the diffusion stage runs at ~0.66% of the A100's fp32 peak
while nvidia-smi reads ~48% busy — it is launch/dispatch-bound by roughly 25x.
So the win here is not the arithmetic saved, it is the ~19% of transformer
layer-launches removed.

The redundancy, from the source:

  ddim_sample() sets `cond = aud_cond` once and passes it unchanged on all 10
  steps. But MotionDecoder.forward recomputes
      cond_projection -> abs_pos_encoding -> cond_encoder
  every single step. That is 10x redundant.

  Worse, half of it is DEAD. forward() does
      cond_tokens = torch.where(keep_mask_embed, cond_tokens, null_cond_embed)
  and for the unconditional half of the CFG batch keep_mask is all-False, so
  the freshly computed cond_tokens for that half is discarded outright. Same
  for cond_hidden. Since patch_cfg_batch.py made CFG a batch of 2, we compute
  the encoder on two identical copies and throw one away.

  Net: evaluated 20x per window; 1x is needed.

The fix caches the conditioned cond_tokens/cond_hidden against the identity of
the pre-batch cond tensor, which ddim_sample holds constant for the whole
window. The unconditional half never needed computing at all -- it is
null_cond_embed by definition.

VALUE-IDENTICAL up to fp32 rounding: same weights, same inputs, same ops, just
evaluated once. Verify with DITTO_CFG_VERIFY=1 (patch_cfg_verify.py), which
already compares the batched path against the original two-pass form on real
inputs and prints the max relative difference. Expect ~1e-7, the same class of
difference the CFG batching itself produced.

Apply AFTER patch_cfg_batch.py.
"""
import os, shutil, sys

p = os.path.expanduser("~/ditto-talkinghead/core/models/modules/lmdm_modules/model.py")
if not os.path.exists(p + ".precondhoist"):
    shutil.copy(p, p + ".precondhoist")

s = open(p).read()
if "carfox: cond hoist" in s:
    print("already patched")
    sys.exit(0)

# --- 1. forward() accepts a precomputed conditioning pair ---------------------
old_sig = """        self, x: Tensor, cond_frame: Tensor, cond_embed: Tensor, times: Tensor, cond_drop_prob: float = 0.0,
        keep_mask=None,
    ):"""
new_sig = """        self, x: Tensor, cond_frame: Tensor, cond_embed: Tensor, times: Tensor, cond_drop_prob: float = 0.0,
        keep_mask=None, cond_pre=None,
    ):"""
assert s.count(old_sig) == 1, f"signature {s.count(old_sig)}"
s = s.replace(old_sig, new_sig, 1)

# --- 2. skip the encoder when the caller already has the tokens --------------
old_block = """        cond_tokens = self.cond_projection(cond_embed)
        # encode tokens
        cond_tokens = self.abs_pos_encoding(cond_tokens)
        cond_tokens = self.cond_encoder(cond_tokens)

        null_cond_embed = self.null_cond_embed.to(cond_tokens.dtype)
        cond_tokens = torch.where(keep_mask_embed, cond_tokens, null_cond_embed)

        mean_pooled_cond_tokens = cond_tokens.mean(dim=-2)
        cond_hidden = self.non_attn_cond_projection(mean_pooled_cond_tokens)"""

new_block = """        if cond_pre is not None:
            # carfox: cond hoist -- already computed once for this window.
            cond_tokens, cond_hidden = cond_pre
        else:
            cond_tokens = self.cond_projection(cond_embed)
            # encode tokens
            cond_tokens = self.abs_pos_encoding(cond_tokens)
            cond_tokens = self.cond_encoder(cond_tokens)

            null_cond_embed = self.null_cond_embed.to(cond_tokens.dtype)
            cond_tokens = torch.where(keep_mask_embed, cond_tokens, null_cond_embed)

            mean_pooled_cond_tokens = cond_tokens.mean(dim=-2)
            cond_hidden = self.non_attn_cond_projection(mean_pooled_cond_tokens)"""
assert s.count(old_block) == 1, f"cond block {s.count(old_block)}"
s = s.replace(old_block, new_block, 1)

# --- 3. guided_forward computes it once per window and builds the CFG pair ----
old_call = """        out = self.forward(
            torch.cat([x, x], 0),
            torch.cat([cond_frame, cond_frame], 0),
            torch.cat([cond_embed, cond_embed], 0),
            torch.cat([times, times], 0),
            keep_mask=keep,
        )"""
new_call = """        # carfox: cond hoist. ddim_sample holds cond_embed constant for the
        # whole window, so the encoder runs once per window rather than once
        # per step per CFG half. Keyed on tensor identity + version so a new
        # window (or an in-place write) invalidates it.
        ver = getattr(cond_embed, "_version", 0)
        key = (id(cond_embed), ver, cond_embed.shape)
        if getattr(self, "_cond_key", None) != key:
            ct = self.cond_encoder(self.abs_pos_encoding(self.cond_projection(cond_embed)))
            null_e = self.null_cond_embed.to(ct.dtype)
            null_h = self.null_cond_hidden.to(ct.dtype)
            ch = self.non_attn_cond_projection(ct.mean(dim=-2))
            # unconditional half is null BY DEFINITION -- never worth computing
            nt = null_e.expand_as(ct) if null_e.shape != ct.shape else null_e
            nh = null_h.expand_as(ch) if null_h.shape != ch.shape else null_h
            self._cond_key = key
            self._cond_pre = (
                torch.cat([nt, ct], 0).contiguous(),
                torch.cat([nh, ch], 0).contiguous(),
            )
        out = self.forward(
            torch.cat([x, x], 0),
            torch.cat([cond_frame, cond_frame], 0),
            torch.cat([cond_embed, cond_embed], 0),
            torch.cat([times, times], 0),
            keep_mask=keep,
            cond_pre=self._cond_pre,
        )"""
assert s.count(old_call) == 1, f"guided call {s.count(old_call)}"
s = s.replace(old_call, new_call, 1)

open(p, "w").write(s)
print("PATCHED: audio conditioning hoisted out of the DDIM loop and the CFG batch")
