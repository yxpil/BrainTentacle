// /dl/v<版本>/<文件名> —— 安装包出口。
//
// 两条路径，同一套 URL（客户端白名单只认 osbt.space，所以不能换主机名）：
//   1. 配了 R2 绑定 DL_BUCKET：先读桶；命中直接吐字节（不打 GitHub）。
//   2. 未配或未命中：从 GitHub Releases 转发给客户端，同时在后台把文件灌进桶。
//      灌桶失败或大小对不上就删掉半截对象，绝不让损坏的安装包留在桶里。
const REPO = "yxpil/BrainTentacle";
const SAFE = /^[A-Za-z0-9._-]+$/;

function bad(msg, status) {
  return new Response(msg, {
    status: status || 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function baseHeaders(file) {
  return {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${file}"`,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
  };
}

function fromR2(obj, file, ranged) {
  const h = new Headers(baseHeaders(file));
  if (obj.httpMetadata && obj.httpMetadata.contentType) h.set("content-type", obj.httpMetadata.contentType);
  if (obj.httpEtag) h.set("etag", obj.httpEtag);
  else if (obj.etag) h.set("etag", obj.etag);
  if (obj.uploaded) h.set("last-modified", new Date(obj.uploaded).toUTCString());
  h.set("x-dl-source", "r2");
  if (ranged && obj.range) {
    const { offset, length } = obj.range;
    h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set("content-length", String(length));
  } else {
    h.set("content-length", String(obj.size));
  }
  return new Response(obj.body || null, { status: ranged && obj.range ? 206 : 200, headers: h });
}

// 后台灌桶：独立 fetch 一份，写完核对大小，不符即删
async function fill(bucket, key, upstream) {
  try {
    const r = await fetch(upstream, { headers: { "user-agent": "osbt-space-fill" }, redirect: "follow" });
    if (!r.ok || !r.body) return;
    const expect = Number(r.headers.get("content-length") || 0);
    await bucket.put(key, r.body, {
      httpMetadata: { contentType: r.headers.get("content-type") || "application/octet-stream" },
      customMetadata: { src: "github-releases" },
    });
    if (expect) {
      const head = await bucket.head(key);
      if (!head || head.size !== expect) await bucket.delete(key);
    }
  } catch (e) {
    // 灌桶是尽力而为，失败不影响本次下载
  }
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

  const key = `${tag}/${file}`;
  const bucket = ctx.env && ctx.env.DL_BUCKET;
  const range = req.headers.get("range");
  const upstream = `https://github.com/${REPO}/releases/download/${tag}/${file}`;

  // 1) 先试 R2
  if (bucket) {
    try {
      if (req.method === "HEAD") {
        const head = await bucket.head(key);
        if (head) return new Response(null, { status: 200, headers: fromR2(head, file, false).headers });
      } else {
        const obj = range
          ? await bucket.get(key, { range: new Headers(req.headers) })
          : await bucket.get(key);
        if (obj) return fromR2(obj, file, Boolean(range));
      }
    } catch (e) {
      // 桶异常时静默回落到 GitHub
    }
  }

  // 2) 回落 GitHub
  const headers = { "user-agent": "osbt.space-dl-proxy" };
  if (range) headers["range"] = range;
  const res = await fetch(upstream, { method: req.method, headers, redirect: "follow" });
  if (!res.ok) {
    return bad(`上游返回 ${res.status}：该版本或文件名可能已不存在。直接下载：${upstream}`, res.status === 404 ? 404 : 502);
  }

  const out = new Headers(baseHeaders(file));
  for (const k of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  out.set("x-dl-source", "github");

  // 第一次整包下载时顺手灌桶（Range 请求不灌，避免写半截）
  if (bucket && !range && req.method === "GET") {
    ctx.waitUntil(fill(bucket, key, upstream));
  }

  return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}
