# osbt.space 站点源码

线上 <https://osbt.space> 的完整源文件，宿主是 Cloudflare Pages 项目 `osbt-space`（直传部署，不接 GitHub 自动构建）。

## 结构

```
site/
├── index.html          首页（单文件自包含：CSS/JS 全内联，无外部字体与依赖）
├── page.css            次级页共用样式（隐私政策 / 跳转页）
├── privacy.html        隐私政策（中英全文）
├── docs.html           文档迁移提示页（自动跳转到仓库 README）
├── icon.png            站点图标（与桌面端同一枚品牌图标）
├── robots.txt / sitemap.xml
└── functions/
    ├── latest.json.js  /latest.json 自动更新清单（实时读 GitHub Release，边缘缓存 5 分钟）
    └── dl/[[path]].js  /dl/v<版本>/<文件名> 安装包转发（服务端取 GitHub Releases，透传 Range）
```

## 两条不能破坏的约定

1. `/latest.json` 的 `assets` 键必须保持
   `windows-x64` `windows-arm64` `macos-x64` `macos-arm64` `linux-x64` `linux-arm64` ——
   与 `crates/bit-core/src/update.rs` 的 `pick_asset` 一一对应。
2. 下载地址的主机必须是 `osbt.space`（客户端白名单只认 `osbt.space` / `yxpil.github.io` / `github.com` 及其资产 CDN），
   因此站内所有安装包链接走 `/dl/v<版本>/<文件名>`，由函数转发，不直接暴露 GitHub 域名。

## 发布

```bash
cd site
npx --yes wrangler@3 pages deploy . --project-name=osbt-space --branch=main --commit-dirty=true
```

需要环境变量 `CLOUDFLARE_API_TOKEN`（Pages:Edit 权限）与 `CLOUDFLARE_ACCOUNT_ID`。
预览可用 `--branch=<任意分支名>`，会得到 `https://<项目>.<分支>.pages.dev` 而不动生产。

改动上线后请复验：`/`、`/privacy`、`/docs`、`/latest.json`、`/dl/v<版本>/<任意资产>`（HEAD 与 Range）。
