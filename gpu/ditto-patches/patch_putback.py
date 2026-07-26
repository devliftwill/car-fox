"""Cache the constant warped mask in the paste-back stage.

For a photo avatar the source frame and its crop transform never change, so
`cv2.warpAffine(mask, M_c2o)` produces the identical image 25 times a second.
That warp is cached here. The rendered face is still warped every frame -- that
part is real work.

DO NOT also hoist `result_buffer` out of the per-frame path. I tried it for the
786KB/frame allocation saving and it was a serious regression: this function
ends with `return self.result_buffer`, so a shared buffer makes every frame in
a batch alias the same pixels. All 5 ticks of a 200ms window then render
whatever was written last -- 80% of transmitted frames byte-identical, ~5
effective fps, visibly choppy while the mouth is moving.

It hid from everything: fps stayed 25.0 (duplicates are transmitted on time),
identical_frame_ratio stayed 0.000 (WebRTC noise), and even the session
recording looked fine (JPEG q55 -> x264 reconstructs identical inputs slightly
differently, which is why the mp4 read ~12% rather than 80%). Only CRCing the
raw frame bytes before compression found it -- see the "frames are distinct"
check in acceptance_test.py, which now guards this.
"""
import os, shutil, sys

p = os.path.expanduser("~/ditto-talkinghead/core/atomic_components/putback.py")
if not os.path.exists(p + ".orig"):
    shutil.copy(p, p + ".orig")

s = open(p).read()
if "carfox: cache" in s:
    print("already patched")
    sys.exit(0)

old = """    def __call__(self, frame_rgb, render_image, M_c2o):
        h, w = frame_rgb.shape[:2]
        mask_warped = cv2.warpAffine(
            self.mask_ori_float, M_c2o[:2, :], dsize=(w, h), flags=cv2.INTER_LINEAR
        ).clip(0, 1)"""

new = """    def __call__(self, frame_rgb, render_image, M_c2o):
        h, w = frame_rgb.shape[:2]
        # carfox: cache the warped mask. M_c2o is fixed for a still-image
        # avatar, so this warp returned the same pixels 25 times a second.
        # The mask is read-only, so sharing it is safe -- unlike result_buffer,
        # which this function RETURNS (see the module docstring).
        key = (h, w, M_c2o.tobytes())
        if getattr(self, "_mask_key", None) != key:
            self._mask_key = key
            self._mask_warped = cv2.warpAffine(
                self.mask_ori_float, M_c2o[:2, :], dsize=(w, h), flags=cv2.INTER_LINEAR
            ).clip(0, 1)
        mask_warped = self._mask_warped"""

assert s.count(old) == 1, f"pattern count {s.count(old)}"
open(p, "w").write(s.replace(old, new, 1))
print("PATCHED putback: cached mask warp (result buffer left per-frame)")
