"""Stop redoing constant work for every frame in the paste-back stage.

For a photo avatar the source frame and its crop transform never change, so
`cv2.warpAffine(mask, M_c2o)` produces the identical image 25 times a second,
and a fresh 786KB output buffer is allocated just as often. Cache both.
The rendered face still gets warped every frame -- that part is real work.
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
        ).clip(0, 1)
        frame_warped = cv2.warpAffine(
            render_image, M_c2o[:2, :], dsize=(w, h), flags=cv2.INTER_LINEAR
        )
        self.result_buffer = np.empty((h, w, 3), dtype=np.uint8)"""

new = """    def __call__(self, frame_rgb, render_image, M_c2o):
        h, w = frame_rgb.shape[:2]
        # carfox: cache the warped mask and the output buffer. M_c2o is fixed
        # for a still-image avatar, so this warp returned the same pixels 25
        # times a second, and a 786KB buffer was allocated just as often.
        key = (h, w, M_c2o.tobytes())
        if getattr(self, "_mask_key", None) != key:
            self._mask_key = key
            self._mask_warped = cv2.warpAffine(
                self.mask_ori_float, M_c2o[:2, :], dsize=(w, h), flags=cv2.INTER_LINEAR
            ).clip(0, 1)
            self.result_buffer = np.empty((h, w, 3), dtype=np.uint8)
        mask_warped = self._mask_warped
        frame_warped = cv2.warpAffine(
            render_image, M_c2o[:2, :], dsize=(w, h), flags=cv2.INTER_LINEAR
        )"""

assert s.count(old) == 1, f"pattern count {s.count(old)}"
open(p, "w").write(s.replace(old, new, 1))
print("PATCHED putback: cached mask warp + reused buffer")
