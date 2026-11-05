// /dl/v<版本>/<文件名> → 转发到 GitHub Releases 资产。
// 目的：客户端（浏览器与应用内更新）不直接跳转到 GitHub 域名，弱网/受限网络下也能落地。
const REPO = "yxpil/BrainTentacle";
const SAFE = /^[A-Za-z0-9._-]+$/;

function bad(msg, status) {
  return new Response(msg, {
    status: status || 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequest(ctx) {
  const req = ctx.request;
  if (req.method !== "GET" && req.method !== "HEAD") return bad("Method Not Allowed", 405);

  const path = new URL(req.url).pathname.replace(/^\/dl\//, "");
  const parts = path.split("/");
  if (parts.length !== 2) return bad("Bad request", 400);

  const tag = decodeURIComponent(parts[0]);
  const file = decodeURIComponent(parts[1]);
  if (!/^v[0-9A-Za-z._-]+$/.test(tag) || tag.includes("..")) return bad("Bad tag", 400);
  if (!SAFE.test(file) || file.includes("..")) return bad("Bad file", 400);

  const upstream = `https://github.com/${REPO}/releases/download/${tag}/${file}`;
  const headers = { "user-agent": "osbt.space-dl-proxy" };
  if (req.headers.get("range")) headers["range"] = req.headers.get("range");

  const res = await fetch(upstream, { method: req.method, headers, redirect: "follow" });
  if (!res.ok) {
    return bad(`上游返回 ${res.status}：该版本或文件名可能已不存在。直接下载：${upstream}`, res.status === 404 ? 404 : 502);
  }

  const out = new Headers();
  const keep = ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"];
  for (const k of keep) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has("content-type")) out.set("content-type", "application/octet-stream");
  out.set("content-disposition", `attachment; filename="${file}"`);
  out.set("cache-control", "public, max-age=3600");
  out.set("x-dl-upstream", "github.com");

  return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}
