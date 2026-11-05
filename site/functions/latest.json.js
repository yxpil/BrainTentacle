// /latest.json — 桌面端与命令行版的自动更新清单。
// 键名与 bit-core::update::pick_asset 一一对应，assets 指向本站 /dl/ 转发地址（受信任主机）。
// 边缘缓存 5 分钟，避免每次检查更新都打 GitHub API。
const REPO = "yxpil/BrainTentacle";
const CACHE_SECONDS = 300;

const KEYED = {
  "windows-x64": /BIT_.+_x64-setup\.exe$/i,
  "windows-arm64": /BIT_.+_aarch64-setup\.exe$/i,
  "macos-arm64": /BIT_.+_aarch64-app\.zip$/i,
  "macos-x64": /BIT_.+_x64-app\.zip$/i,
  "linux-x64": /BIT_.+_amd64\.AppImage$/i,
  "linux-arm64": /BIT_.+_aarch64\.AppImage$/i,
};

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequestGet(ctx) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "osbt.space-latest-json",
    },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) return json({ error: "GitHub API 暂不可达", status: res.status }, 502);

  const rel = await res.json();
  const ver = String(rel.tag_name || "").replace(/^v/, "");
  if (!ver) return json({ error: "release tag 缺失" }, 502);

  const assets = {};
  for (const [key, re] of Object.entries(KEYED)) {
    const hit = (rel.assets || []).find((a) => re.test(a.name));
    if (hit) assets[key] = `https://osbt.space/dl/v${ver}/${hit.name}`;
  }

  return json({
    version: ver,
    notes: rel.body || "",
    url: rel.html_url || `https://github.com/${REPO}/releases`,
    assets,
  });
}
