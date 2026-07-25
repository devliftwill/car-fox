"""Batch the Ditto warp stage (now the bottleneck after decode was batched).

Same batch-1 problem as decode. Additionally, for a photo avatar the source
feature f_s is the SAME array every frame, so it is uploaded once and expanded
across the batch instead of being copied to the GPU per frame (8.4MB/frame).
Per-frame output contract is unchanged: (1, C, H, W) numpy.
"""
import os, shutil, sys

# ---- 1) WarpNetwork.batch() -------------------------------------------------
wn = os.path.expanduser("~/ditto-talkinghead/core/models/warp_network.py")
if not os.path.exists(wn + ".prebatch"):
    shutil.copy(wn, wn + ".prebatch")
s = open(wn).read()
if "def batch(self" not in s:
    anchor = "    def __call__(self, feature_3d, kp_source, kp_driving):"
    assert anchor in s, "WarpNetwork.__call__ not found"
    method = '''    def batch(self, triples):
        """carfox: warp several frames in ONE forward pass.

        triples: list of (feature_3d, kp_source, kp_driving) numpy arrays.
        Returns a list of (1, C, H, W) numpy arrays -- same contract as
        __call__ per item. For a photo avatar feature_3d is the identical
        array each frame, so it is uploaded once and expanded (saves an
        8.4MB host->device copy per frame).
        """
        if self.model_type != "pytorch" or len(triples) == 1:
            return [self(*t) for t in triples]
        n = len(triples)
        with torch.no_grad(), torch.autocast(device_type=self.device[:4], dtype=torch.float16, enabled=True):
            f0 = triples[0][0]
            if all(t[0] is f0 for t in triples):
                cache = getattr(self, "_fs_cache", None)
                if cache is None or cache[0] is not f0:
                    cache = (f0, torch.from_numpy(f0).to(self.device))
                    self._fs_cache = cache
                f3 = cache[1].expand(n, *cache[1].shape[1:])
            else:
                f3 = torch.from_numpy(np.concatenate([t[0] for t in triples], 0)).to(self.device)
            ks = torch.from_numpy(np.concatenate([t[1] for t in triples], 0)).to(self.device)
            kd = torch.from_numpy(np.concatenate([t[2] for t in triples], 0)).to(self.device)
            pred = self.model(f3, ks, kd).float().cpu().numpy()
        return [pred[i : i + 1] for i in range(pred.shape[0])]

'''
    s = s.replace(anchor, method + anchor)
    open(wn, "w").write(s)
    print("PATCHED warp_network.py (added batch())")
else:
    print("warp_network.py already has batch()")

# ---- 2) WarpF3D passthrough --------------------------------------------------
comp = os.path.expanduser("~/ditto-talkinghead/core/atomic_components/warp_f3d.py")
if not os.path.exists(comp + ".prebatch"):
    shutil.copy(comp, comp + ".prebatch")
s = open(comp).read()
if "def batch(self" not in s:
    anchor = "    def __call__(self, f_s, x_s, x_d):"
    assert anchor in s
    s = s.replace(anchor, "    def batch(self, triples):\n        return self.warp_net.batch(triples)\n\n" + anchor)
    open(comp, "w").write(s)
    print("PATCHED warp_f3d.py (batch passthrough)")
else:
    print("warp_f3d.py already patched")

# ---- 3) worker: drain a batch ----------------------------------------------
pipe = os.path.expanduser("~/ditto-talkinghead/stream_pipeline_online.py")
if not os.path.exists(pipe + ".prewarpbatch"):
    shutil.copy(pipe, pipe + ".prewarpbatch")
s = open(pipe).read()
if "carfox batched warp" in s:
    print("pipeline warp worker already patched")
    sys.exit(0)

old = """            frame_idx, x_s, x_d = item
            f_s = self.source_info["f_s_lst"][frame_idx]
            f_3d = self.warp_f3d(f_s, x_s, x_d)
            self.decode_f3d_queue.put([frame_idx, f_3d])"""
new = """            # ---- carfox batched warp ----
            batch_n = int(os.environ.get("DITTO_WARP_BATCH", "4"))
            items = [item]
            while len(items) < batch_n:
                try:
                    nxt = self.warp_f3d_queue.get_nowait()
                except queue.Empty:
                    break
                if nxt is None:
                    self._warp_saw_end = True
                    break
                items.append(nxt)
            triples = [(self.source_info["f_s_lst"][it[0]], it[1], it[2]) for it in items]
            f_3ds = self.warp_f3d.batch(triples)
            for it, f_3d in zip(items, f_3ds):
                self.decode_f3d_queue.put([it[0], f_3d])
            if getattr(self, "_warp_saw_end", False):
                self.decode_f3d_queue.put(None)
                break"""
assert old in s, "warp worker body not found"
open(pipe, "w").write(s.replace(old, new))
print("PATCHED stream_pipeline_online.py (batched warp worker)")
