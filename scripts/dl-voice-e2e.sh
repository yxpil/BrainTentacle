#!/bin/zsh
# e2e 前置：把 KWS/sense-voice/whisper-tiny 模型从 ModelScope 下到应用数据目录（模拟应用下载器）
set -e
D="$HOME/Library/Application Support/com.bit.hub/voice"
MS="https://www.modelscope.cn/models"
mkdir -p "$D/kws" "$D/sense-voice" "$D/whisper-tiny"

dl() { # dl <url> <dest>
  local url="$1" dest="$2"
  echo "[$(date +%H:%M:%S)] ↓ ${dest:t}"
  /usr/bin/curl --http1.1 -sL -C - --retry 3 -o "$dest" "$url"
  echo "[$(date +%H:%M:%S)] ✓ ${dest:t} $(stat -f%z "$dest")"
}

KWS="$MS/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/resolve/master"
SV="$MS/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master"
WH="$MS/pengzhendong/sherpa-onnx-whisper-tiny/resolve/master"
VAD="$MS/pengzhendong/silero-vad/resolve/master/silero_vad.onnx"

# KWS（5MB）
dl "$KWS/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$D/kws/encoder.int8.onnx"
dl "$KWS/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$D/kws/decoder.onnx"
dl "$KWS/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"  "$D/kws/joiner.int8.onnx"
dl "$KWS/tokens.txt"                                        "$D/kws/tokens.txt"

# whisper-tiny（103MB）
dl "$WH/tiny-tokens.txt"          "$D/whisper-tiny/tokens.txt"
dl "$WH/tiny-encoder.int8.onnx"   "$D/whisper-tiny/encoder.int8.onnx"
dl "$WH/tiny-decoder.int8.onnx"   "$D/whisper-tiny/decoder.int8.onnx"
dl "$VAD"                         "$D/whisper-tiny/silero_vad.onnx"

# sense-voice（241MB）
dl "$SV/tokens.txt"        "$D/sense-voice/tokens.txt"
dl "$VAD"                  "$D/sense-voice/silero_vad.onnx"
dl "$SV/model.int8.onnx"   "$D/sense-voice/model.int8.onnx"

echo "ALL-DONE"
for v in kws sense-voice whisper-tiny; do ls -la "$D/$v" | awk 'NR>1 && $9!="." && $9!=".." {print $5, $9}'; echo "-- $v"; done
