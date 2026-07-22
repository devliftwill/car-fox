#!/usr/bin/env bash
# Neural mouth GPU server — one-shot setup on a fresh GCE Deep Learning VM
# (image family common-cu121-debian-11: CUDA + conda preinstalled).
set -euo pipefail

echo "== nvidia check =="
nvidia-smi

echo "== clone LiveTalking =="
cd "$HOME"
[ -d LiveTalking ] || git clone https://github.com/lipku/LiveTalking.git
cd LiveTalking

echo "== conda env =="
conda create -y -n nerfstream python=3.10 || true
# shellcheck disable=SC1091
source activate nerfstream

echo "== python deps =="
conda install -y pytorch==2.1.2 torchvision cudatoolkit -c pytorch -c nvidia || \
  pip install torch==2.1.2 torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt

echo "== MuseTalk weights =="
# Follow the repo's current instructions (weights layout changes between
# releases): https://github.com/lipku/LiveTalking#readme  /  MuseTalk README.
# Typically: sh ./scripts/download_models.sh or the huggingface-cli pulls
# listed in the docs, into ./models/
echo ">> Download MuseTalk weights per the LiveTalking README into ./models"

echo "== firewall note =="
echo ">> open tcp:8010 (webrtc signaling / http) to the site's origin:"
echo "   gcloud compute firewall-rules create fox-neural-8010 --allow tcp:8010"

echo "== run =="
echo ">> python app.py --transport webrtc --model musetalk"
echo ">> then prep our avatar from carfox-web/public/demo-idle.mp4 per docs"
