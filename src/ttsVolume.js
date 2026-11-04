// TTS 播放音量：各引擎对「合成端音量」的支持参差不齐（edge 有 SSML volume，
// gtts / siliconflow / openai / 本地 sherpa-onnx 内核都没有这个入参），
// 所以把音量做成统一的播放增益——一个旋钮对所有引擎都成立，也无需重新合成。
// 只存本机偏好：音量属于「这台机器的耳朵」，不属于会话或模型配置。

const KEY = "bit.ttsVolume";

/// 当前音量百分比（0-100），缺省 100
export function ttsVolumePct() {
  const v = parseInt(localStorage.getItem(KEY));
  return v >= 0 && v <= 100 ? v : 100;
}

/// 写入音量百分比，返回落库后的值
export function setTtsVolumePct(pct) {
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  localStorage.setItem(KEY, String(v));
  return v;
}

/// 给待播放的 Audio 挂上音量；满音量不动，避免浏览器做无谓衰减
export function applyTtsVolume(audio) {
  const pct = ttsVolumePct();
  if (pct < 100) audio.volume = pct / 100;
  return audio;
}
