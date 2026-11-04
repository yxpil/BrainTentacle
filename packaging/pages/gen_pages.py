#!/usr/bin/env python3
"""生成触手怪 GitHub Pages 下载页。

替代 mirror-pages.yml 里的 shell 拼接：按「系统 + 架构 + 包类型」分组标注每个资产，
并用浏览器端的 Client Hints 识别访问者设备，把匹配的那个标成推荐、
对明显下错的组合加一道确认——避免出现「x64 电脑点了 ARM64 包」这类误选。

用法：
    python3 gen_pages.py --assets-dir site/0.6.51 --version 0.6.51 --latest-tag v0.6.51
"""

import argparse
import html
import os

# ---------------------------------------------------------------- 资产分类

# 架构令牌 -> (匹配用的键, 界面显示名)
ARCH_TOKENS = {
    "x64": ("x64", "x64"),
    "amd64": ("x64", "x64"),
    "x86_64": ("x64", "x64"),
    "aarch64": ("arm64", "ARM64"),
    "arm64": ("arm64", "ARM64"),
    "loongarch64": ("loongarch64", "LoongArch64"),
    "riscv64": ("riscv64", "RISC-V 64"),
    "ppc64le": ("ppc64le", "PowerPC ppc64le"),
}

# 同一 (系统, 架构) 里，数字越小越适合作为「推荐」入口
KIND_PRIORITY = {
    "windows-installer": 0,
    "macos-dmg": 0,
    "linux-appimage": 1,
    "linux-deb": 0,
    "linux-rpm": 2,
    "macos-app-zip": 3,
    "windows-portable": 4,
    "cli-tar": 1,
    "cli-deb": 0,
    "cli-rpm": 2,
}

OS_LABEL = {"windows": "Windows", "macos": "macOS", "linux": "Linux",
            "cli": "命令行工具 / CLI", "other": "其他 / Other"}
GROUP_ORDER = ["windows", "macos", "linux", "cli", "other"]

# 组内排序：常见架构在前。ARM64 排在 x64 前面等于把误选陷阱摆到用户第一眼的位置上。
ARCH_RANK = {"x64": 0, "arm64": 1}

ANDROID_URL = "https://github.com/yxpil/bit-mobile"


def _arch_of(name):
    low = name.lower()
    for token, (key, disp) in ARCH_TOKENS.items():
        # 只认文件名里独立成段的架构令牌（前后是 _ - . 或边界），避免 x64 命中 x64-app 之外的怪串
        if ("_" + token) in low or ("-" + token) in low or ("." + token) in low:
            return key, disp
    return None, None


def classify(name):
    """-> dict(kind, os, arch, arch_disp) 或 None（未识别）"""
    low = name.lower()
    arch, arch_disp = _arch_of(low)

    if low == "latest.json":
        return {"kind": "manifest", "os": "other", "arch": None, "arch_disp": None}

    is_cli = low.startswith("bit-cli")

    if low.endswith("-setup.exe"):
        return {"kind": "windows-installer", "os": "windows", "arch": arch, "arch_disp": arch_disp}
    if low.endswith("-portable.zip"):
        return {"kind": "windows-portable", "os": "windows", "arch": arch, "arch_disp": arch_disp}
    if low.endswith("-app.zip"):
        return {"kind": "macos-app-zip", "os": "macos", "arch": arch, "arch_disp": arch_disp}
    if low.endswith(".dmg"):
        return {"kind": "macos-dmg", "os": "macos", "arch": arch, "arch_disp": arch_disp}
    if low.endswith(".appimage"):
        kind = "cli-appimage" if is_cli else "linux-appimage"
        return {"kind": kind, "os": "linux", "arch": arch, "arch_disp": arch_disp}
    if low.endswith(".deb"):
        return {"kind": "cli-deb" if is_cli else "linux-deb",
                "os": "linux", "arch": arch, "arch_disp": arch_disp}
    if low.endswith(".rpm"):
        return {"kind": "cli-rpm" if is_cli else "linux-rpm",
                "os": "linux", "arch": arch, "arch_disp": arch_disp}
    if low.endswith(".tar.gz"):
        return {"kind": "cli-tar", "os": "cli" if is_cli else "linux",
                "arch": arch, "arch_disp": arch_disp}

    return {"kind": "other", "os": "other", "arch": arch, "arch_disp": arch_disp}


def group_of(info):
    # bit-cli 的 .deb/.rpm 也是 linux 包，但它们是命令行工具，不跟图形版混在一组
    if info["kind"].startswith("cli") or info["os"] == "cli" or info["kind"] == "manifest":
        return "cli"
    if info["os"] in ("windows", "macos", "linux"):
        return info["os"]
    return "other"


def describe(info):
    """界面上一行说明：包类型 + 该架构的注意事项。"""
    kind = info["kind"]
    a = info["arch_disp"] or "通用"
    table = {
        "windows-installer": "%s 安装包（安装向导）" % a,
        "windows-portable": "%s 便携版，解压即用、不写注册表" % a,
        "macos-dmg": "%s 安装镜像，拖进「应用程序」" % a,
        "macos-app-zip": "%s 应用压缩包（.app）" % a,
        "linux-deb": "%s .deb 包（Debian / Ubuntu）" % a,
        "linux-rpm": "%s .rpm 包（Fedora / openSUSE）" % a,
        "linux-appimage": "%s AppImage，免安装" % a,
        "cli-deb": "命令行 %s .deb" % a,
        "cli-rpm": "命令行 %s .rpm" % a,
        "cli-tar": "命令行 %s 压缩包" % a,
        "cli-appimage": "命令行 %s AppImage" % a,
        "manifest": "自动更新清单（给客户端用，不用手动下载）",
        "other": "其他资产",
    }
    return table.get(kind, table["other"])


def warning(info):
    """下错会出问题的组合，页面上直接写明白。"""
    if info["kind"] == "windows-installer" and info["arch"] == "arm64":
        return "给 ARM 版 Windows（骁龙 / 微软 SQ 系列）用。常见的 x64 电脑装不了，安装器会直接拒绝。"
    if info["kind"] == "windows-portable" and info["arch"] == "arm64":
        return "ARM 版 Windows 专用。x64 电脑解压后程序打不开。"
    if info["kind"] == "windows-installer" and info["arch"] == "x64":
        return "绝大多数 Windows 电脑选这个。"
    return None


# ---------------------------------------------------------------- 页面渲染

CSS = r""":root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:40px 16px 56px;background:#fff;color:#111;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:680px;margin:0 auto;text-align:center}
h1{font-size:22px;margin:0 0 4px;letter-spacing:.5px}
.sub{color:#666;font-size:13px;margin:0 0 20px}
#detect{margin:0 auto 22px;max-width:560px;padding:10px 16px;border:1px solid #111;border-radius:10px;font-size:13px;text-align:left;background:#fff}
#detect b{font-weight:600}
#detect.dim{border-color:#ddd;color:#666}
section{margin:0 auto 22px;max-width:560px;text-align:left}
section h2{font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#888;margin:0 0 8px;padding-left:2px}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
li{margin:0;min-width:0}
a{display:block;border:1px solid #111;border-radius:12px;padding:10px 16px;color:#111;text-decoration:none;font-size:14px;min-width:0;background:#fff}
a:hover{background:#111;color:#fff}
a.pick{background:#111;color:#fff}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.name{font-weight:600;overflow-wrap:anywhere}
.size{opacity:.55;font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;font-size:13px}
.desc{display:block;font-size:12px;opacity:.7;margin-top:2px}
.tag{display:inline-block;margin-left:6px;font-size:11px;border:1px solid currentColor;border-radius:999px;padding:0 8px;vertical-align:1px;opacity:.85;white-space:nowrap}
a.pick .tag{border-color:#fff}
.warn{display:block;font-size:12px;margin-top:4px;padding-top:4px;border-top:1px dashed rgba(128,128,128,.4);opacity:.85}
.other ul li a{border-color:#bbb}
.foot{margin:26px auto 0;max-width:560px;font-size:12px;color:#666;text-align:center}
.foot a{display:inline;border:0;padding:0;border-radius:0;color:#666;text-decoration:none;font-size:12px}
.foot a:hover{background:none;color:#111}"""

# 浏览器端识别：Client Hints 优先（Windows on ARM 的 UA 串会伪装成 Win64;x64，
# 只有高熵值能区分），拿不到再退回 UA，再退回「不确定」。
SCRIPT = r"""(function(){
 var GROUPZH={windows:"Windows",macos:"macOS",linux:"Linux",cli:"命令行工具"};
 function normArch(a){a=(a||"").toLowerCase();
  if(a==="arm"||a==="arm64"||a==="aarch64")return"arm64";
  if(a==="x86"||a==="x64"||a==="amd64")return"x64";return a;}
 function normPlat(p){p=(p||"").toLowerCase();
  if(p.indexOf("android")>=0)return"android";
  if(p.indexOf("windows")>=0)return"windows";
  if(p.indexOf("macos")>=0||p.indexOf("darwin")>=0||p.indexOf("os x")>=0)return"macos";
  if(p.indexOf("linux")>=0||p.indexOf("ubuntu")>=0||p.indexOf("debian")>=0)return"linux";
  return null;}
 function fromUA(){var ua=navigator.userAgent||"",p=null,a=null;
  if(/Windows NT/i.test(ua))p="windows";
  else if(/Mac OS X|Macintosh/i.test(ua))p="macos";
  else if(/Android/i.test(ua))p="android";
  else if(/X11|Linux/i.test(ua))p="linux";
  if(/ARM64|arm64|AArch64/i.test(ua))a="arm64";
  else if(/Win64|x64|amd64|x86_64/i.test(ua))a="x64";
  return{os:p,arch:a,confident:false};}
 function detect(){
  var f=fromUA();
  if(navigator.userAgentData&&navigator.userAgentData.getHighEntropyValues){
   return navigator.userAgentData.getHighEntropyValues(["platform","architecture","bitness"])
    .then(function(h){
      var os=normPlat(h.platform)||f.os, arch=normArch(h.architecture)||f.arch;
      if(arch==="x64"&&String(h.bitness)==="32")arch="x86";
      // 高熵值本身是浏览器给出的真实架构，不需要再打折；只有退回 UA 的那条路才不可靠
      return{os:os,arch:arch,confident:true};
    })["catch"](function(){return f;});
  }
  return Promise.resolve(f);
 }
 function label(d){
  var g=d.os?GROUPZH[d.os]||d.os:null;
  var zh=d.arch==="arm64"?"ARM64（ARM 版）":d.arch==="x64"?"x64（64 位）":d.arch?d.arch:"";
  if(g&&zh)return g+" · "+zh;
  if(g&&d.os==="linux")return"Linux";
  return g||zh||null;
 }
 // 这台电脑能不能跑这个包。模拟层是单向的：ARM64 主机能跑 x64（Windows on ARM 自带
 // x64 模拟、Apple 芯片有 Rosetta），反过来不行 —— x64 主机跑不了 ARM64 二进制。
 // 不写清这条，就会对着 ARM 电脑的用户瞎报警，反而没人信提示了。
 function verdict(d, a){
  var os=a.dataset.os, ar=a.dataset.arch;
  if(os==="cli"||os==="other")return"ok";
  if(os!==d.os)return"soft";
  if(ar===d.arch)return"ok";
  if(os==="windows"||os==="macos"){
   if(d.arch==="x64"&&ar==="arm64")return"hard";
   if(d.arch==="arm64"&&ar==="x64")return"ok";
  }
  return"soft";
 }
 function archName(a){return a==="arm64"?"ARM64":a==="x64"?"x64":a;}
 function nag(d, shown, a){
  var os=a.dataset.os, ar=a.dataset.arch;
  var theirs=(GROUPZH[os]||os)+(ar?" · "+archName(ar):"");
  if(verdict(d,a)==="hard"){
   return "这台电脑是 "+shown+"，这个文件是 "+theirs+"。\n\n"
     +(os==="windows"?"x64 版 Windows 跑不了 ARM64 程序":"Intel 版 Mac 跑不了 ARM64 版")
     +"，装完双击没反应（新版的安装器会直接拒绝）。\n\n"
     +"请改下 "+archName(d.arch)+" 版；确定还是要下这个文件吗？";
  }
  return "这台电脑识别为 "+shown+"，这个文件是 "+theirs+"。\n\n"
    +"系统或架构不对的话装完可能打不开。确定要下吗？";
 }
 function mark(d){
  var box=document.getElementById("detect");
  var items=[].slice.call(document.querySelectorAll("a[data-os]"));
  var shown=label(d);
  if(!d.os||!d.arch){
   if(box){box.className="dim";box.textContent="没能自动识别出这台电脑的系统或架构（浏览器没开放这个信息）。下面每一项都写清了适用平台，按自己电脑选：Windows 绝大多数电脑看 _x64-setup.exe，文件名里的 aarch64 是给 ARM 版 Windows 的。";}
   return;
  }
  if(d.os==="android"){
   if(box){box.className="";box.innerHTML="识别到：<b>安卓设备</b> —— 安卓版在单独的仓库，不在这里下载。";}
   var mb=document.querySelector("a[data-android]");
   if(mb)mb.classList.add("pick");
   return;
  }
  var sameArch=items.filter(function(a){return a.dataset.os===d.os;});
  var exact=sameArch.filter(function(a){return a.dataset.arch===d.arch;});
  var pool=exact.length?exact:sameArch;
  pool.sort(function(x,y){return (+x.dataset.priority)-(+y.dataset.priority);});
  var pick=pool[0]||null;
  if(pick)pick.classList.add("pick");
  if(box){
   box.className="";
   var t="识别到：<b>"+shown+"</b>";
   if(exact.length)t+=" —— 下面高亮的就是这个。";
   else if(sameArch.length)t+=" —— 这个系统没有完全对得上的包，高亮的是最接近的一个，拿不准看下面每项的说明。";
   else t+=" —— 这个系统的安装包不在本页。";
   if(!d.confident)t+="（凭浏览器用户代理解读，可能不准）";
   box.innerHTML=t;
  }
  items.forEach(function(a){
   a.addEventListener("click",function(ev){
    if(verdict(d,a)==="ok")return;
    if(!confirm(nag(d, shown, a)))ev.preventDefault();
   });
  });
 }
 detect().then(mark);
})();"""


def human_size(n):
    for unit, div in (("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if n >= div:
            return "%.0f%s" % (round(n / div, 1) if n / div < 100 else round(n / div), unit)
    return "%dB" % n


def esc(s):
    return html.escape(s, quote=True)


def render_item(fname, size, info):
    parts = ['<li><a href="./%s" data-os="%s" data-arch="%s" data-priority="%s"' % (
        esc(fname), esc(group_of(info)), esc(info["arch"] or ""),
        str(KIND_PRIORITY.get(info["kind"], 9)))]
    parts.append(">")
    parts.append('<span class="row"><span class="name">%s</span>'
                 '<span class="size">%s</span></span>' % (esc(fname), human_size(size)))
    desc = describe(info)
    tag = ""
    if info["kind"] == "manifest":
        tag = '<span class="tag">manifest</span>'
    parts.append('<span class="desc">%s%s</span>' % (esc(desc), tag))
    warn = warning(info)
    if warn:
        parts.append('<span class="warn">%s</span>' % esc(warn))
    parts.append("</a></li>")
    return "".join(parts)


def build_version_page(assets_dir, version):
    """-> (html_text, stats)"""
    entries = []
    for fname in sorted(os.listdir(assets_dir)):
        full = os.path.join(assets_dir, fname)
        if not os.path.isfile(full) or fname == "index.html":
            continue
        info = classify(fname) or {"kind": "other", "os": "other", "arch": None, "arch_disp": None}
        entries.append((fname, os.path.getsize(full), info))

    buckets = {}
    for fname, size, info in entries:
        buckets.setdefault(group_of(info), []).append((fname, size, info))

    stats = {g: len(buckets.get(g, [])) for g in GROUP_ORDER}

    sections = []
    for grp in GROUP_ORDER:
        rows = buckets.get(grp)
        if not rows:
            continue
        cls = "other" if grp == "other" else ""
        rows.sort(key=lambda r: (KIND_PRIORITY.get(r[2]["kind"], 9),
                                 ARCH_RANK.get(r[2]["arch"], 2), r[0]))
        items = "\n".join(render_item(f, s, i) for f, s, i in rows)
        sections.append('<section class="%s"><h2>%s</h2>\n<ul>\n%s\n</ul></section>'
                        % (cls, esc(OS_LABEL.get(grp, "其他 / Other")), items))

    android = ('<section><h2>手机 / Mobile</h2>\n<ul>\n'
               '<li><a href="%s" data-android="1"><span class="row">'
               '<span class="name">安卓版 bit-mobile</span>'
               '<span class="size">GitHub</span></span>'
               '<span class="desc">安卓手机在独立仓库发布，不在本页文件里</span></a></li>\n'
               '</ul></section>' % ANDROID_URL)

    body = "\n".join([android] + sections)

    return """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>触手怪 %s 下载 / Downloads</title>
<style>%s</style>
</head>
<body>
<div class="wrap">
<h1>触手怪 %s</h1>
<p class=sub>全部资产直链 · All release assets（GitHub Pages 镜像 / mirror）</p>
<div id="detect" class="dim">正在识别这台电脑…</div>
</div>
%s
<p class=foot>触手怪 永久免费 / Tentacle is free forever · <a href="https://osbt.space">osbt.space</a> · <a href="https://github.com/yxpil/BrainTentacle">GitHub</a></p>
<script>%s</script>
</body>
</html>""" % (esc(version), CSS, esc(version), body, SCRIPT), stats


def build_root_page(latest_tag, latest_version):
    return """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>触手怪 下载 / Downloads</title>
<style>%s</style>
</head>
<body>
<div class="wrap">
<h1>触手怪</h1>
<p class=sub>最新版本 / Latest: %s</p>
</div>
<section><h2>入口 / Entry</h2><ul>
<li><a href="%s/" data-os="other" data-arch="" data-priority="0"><span class="row"><span class="name">v%s 全部文件 / All files</span><span class="size">GitHub Pages</span></span><span class="desc">进去后会自动识别这台电脑，把对应的包高亮出来</span></a></li>
<li><a href="latest.json" data-os="other" data-arch="" data-priority="9"><span class="row"><span class="name">latest.json</span><span class="size">manifest</span></span><span class="desc">自动更新清单，客户端用</span></a></li>
</ul></section>
<p class=foot>触手怪 永久免费 / Tentacle is free forever · <a href="https://osbt.space">osbt.space</a> · <a href="https://github.com/yxpil/BrainTentacle">GitHub</a></p>
</body>
</html>""" % (CSS, esc(latest_tag), esc(latest_version), esc(latest_version))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", required=True, help="该版本的资产目录")
    ap.add_argument("--version", required=True, help="不带 v 的版本号，如 0.6.51")
    ap.add_argument("--latest-tag", help="最新 Release tag，给了就顺带刷新站点首页")
    ap.add_argument("--site-root", help="站点根目录，配合 --latest-tag 写首页")
    args = ap.parse_args()

    page, stats = build_version_page(args.assets_dir, args.version)
    out = os.path.join(args.assets_dir, "index.html")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(page)
    known = sum(v for k, v in stats.items() if k != "other")
    print("版本页已生成 %s：%d 个资产（分类 %d，未识别 %d）"
          % (out, sum(stats.values()), known, stats.get("other", 0)))

    if args.latest_tag and args.site_root:
        ver = args.latest_tag.lstrip("v")
        with open(os.path.join(args.site_root, "index.html"), "w",
                  encoding="utf-8", newline="\n") as fh:
            fh.write(build_root_page(args.latest_tag, ver))
        print("站点首页已生成：%s" % os.path.join(args.site_root, "index.html"))


if __name__ == "__main__":
    main()
