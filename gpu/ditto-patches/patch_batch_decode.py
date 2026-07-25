"""Batch the Ditto decode stage.

decode_f3d is the measured bottleneck (its queue is the only one that backs
up) yet the A100 sits at ~65%: the decoder ran one 512x512 frame per call
with a GPU->CPU sync each time. Batching several frames per call raises
occupancy and amortizes the syncs. Behaviour per frame is unchanged.
"""
import os, shutil, sys

# ---- 1) Decoder.batch(): one forward for N features -------------------------
dec = os.path.expanduser("~/ditto-talkinghead/core/models/decoder.py")
if not os.path.exists(dec + ".prebatch"):
    shutil.copy(dec, dec + ".prebatch")
s = open(dec).read()
if "def batch(self" not in s:
    anchor = "    def __call__(self, feature):"
    assert anchor in s, "Decoder.__call__ not found"
    batch_method = '''    def batch(self, features):
        """carfox: decode several frames in ONE forward pass.

        Returns a list of HWC float32 0..255 arrays -- identical contract to
        __call__, just amortized. Falls back to per-frame for non-pytorch
        backends or a single item.
        """
        if self.model_type != "pytorch" or len(features) == 1:
            return [self(f) for f in features]
        with torch.no_grad(), torch.autocast(device_type=self.device[:4], dtype=torch.float16, enabled=True):
            x = torch.from_numpy(np.concatenate(features, 0)).to(self.device, non_blocking=True)
            p = self.model(x)
            p = p.float().clamp_(0, 1).mul_(255).permute(0, 2, 3, 1).contiguous().cpu().numpy()
        return [p[i] for i in range(p.shape[0])]

'''
    s = s.replace(anchor, batch_method + anchor)
    open(dec, "w").write(s)
    print("PATCHED decoder.py (added batch())")
else:
    print("decoder.py already has batch()")

# ---- 2) DecodeF3D passthrough ----------------------------------------------
comp = os.path.expanduser("~/ditto-talkinghead/core/atomic_components/decode_f3d.py")
if not os.path.exists(comp + ".prebatch"):
    shutil.copy(comp, comp + ".prebatch")
s = open(comp).read()
if "def batch(self" not in s:
    anchor = "    def __call__(self, f_s):"
    assert anchor in s
    s = s.replace(anchor, "    def batch(self, f_s_list):\n        return self.decoder.batch(f_s_list)\n\n" + anchor)
    open(comp, "w").write(s)
    print("PATCHED decode_f3d.py (batch passthrough)")
else:
    print("decode_f3d.py already patched")

# ---- 3) worker: drain a batch from the queue -------------------------------
pipe = os.path.expanduser("~/ditto-talkinghead/stream_pipeline_online.py")
if not os.path.exists(pipe + ".prebatch"):
    shutil.copy(pipe, pipe + ".prebatch")
s = open(pipe).read()
if "carfox batched decode" in s:
    print("pipeline already patched")
    sys.exit(0)

old = """            frame_idx, f_3d = item
            render_img = self.decode_f3d(f_3d)
            self.putback_queue.put([frame_idx, render_img])"""
new = """            # ---- carfox batched decode ----
            batch_n = int(os.environ.get("DITTO_DECODE_BATCH", "4"))
            items = [item]
            while len(items) < batch_n:
                try:
                    nxt = self.decode_f3d_queue.get_nowait()
                except queue.Empty:
                    break
                if nxt is None:
                    self._decode_saw_end = True
                    break
                items.append(nxt)
            render_imgs = self.decode_f3d.batch([it[1] for it in items])
            for (frame_idx, _f3d), render_img in zip(items, render_imgs):
                self.putback_queue.put([frame_idx, render_img])
            if getattr(self, "_decode_saw_end", False):
                self.putback_queue.put(None)
                break"""
assert old in s, "decode worker body not found"
s = s.replace(old, new)
if "\nimport os" not in s and "^import os" not in s:
    s = s.replace("import queue", "import os\nimport queue", 1)
open(pipe, "w").write(s)
print("PATCHED stream_pipeline_online.py (batched decode worker)")
