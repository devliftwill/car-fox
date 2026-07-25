"""Move Ditto decoder per-frame post-processing onto the GPU.

The original did, per frame: GPU->CPU copy of a float32 [3,512,512] tensor,
then numpy transpose + clip + multiply over 786k floats on the CPU. Measured
effect: decode_f3d is the pipeline bottleneck, GPU only ~65% utilized, total
production ~21fps against a 25fps realtime requirement -> unbounded latency.
Output contract is unchanged: HWC float32 in 0..255.
"""
import os, shutil, sys

p = os.path.expanduser("~/ditto-talkinghead/core/models/decoder.py")
bak = p + ".orig"
if not os.path.exists(bak):
    shutil.copy(p, bak)

s = open(p).read()
if "carfox: do the per-frame post-processing ON THE GPU" in s:
    print("ALREADY PATCHED")
    sys.exit(0)

old = """        elif self.model_type == 'pytorch':
            with torch.no_grad(), torch.autocast(device_type=self.device[:4], dtype=torch.float16, enabled=True):
                pred = self.model(torch.from_numpy(feature).to(self.device)).float().cpu().numpy()"""

new = """        elif self.model_type == 'pytorch':
            with torch.no_grad(), torch.autocast(device_type=self.device[:4], dtype=torch.float16, enabled=True):
                x = torch.from_numpy(feature).to(self.device, non_blocking=True)
                _p = self.model(x)
                # carfox: do the per-frame post-processing ON THE GPU. The
                # original copied float32 [3,512,512] to CPU then transposed,
                # clipped and scaled 786k floats in numpy per frame, leaving
                # the A100 at ~65% and capping production at ~21fps -- below
                # the 25fps realtime requirement, so latency grew without
                # bound. Same output contract: HWC float32 in 0..255.
                return _p[0].float().clamp_(0, 1).mul_(255).permute(1, 2, 0).contiguous().cpu().numpy()"""

assert old in s, "decoder pytorch branch not found -- inspect file"
open(p, "w").write(s.replace(old, new))
print("PATCHED decoder.py")
