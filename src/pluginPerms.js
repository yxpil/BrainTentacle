// yxpil · 插件权限词表
// 插件详情页与设置中心的「插件权限」页共用同一份权限人话说明，
// 避免两处各写一份后新权限只在一边退化成裸名字。
// 与后端 KNOWN_PERMS 一一对应：清单里出现没登记的名字会被拒载入。
export const PERM_KEY = {
  css: "plugin.perm.css",
  js: "plugin.perm.js",
  invoke: "plugin.perm.invoke",
  server: "plugin.perm.server",
  page: "plugin.perm.page",
  chat: "plugin.perm.chat",
  settings: "plugin.perm.settings",
  session: "plugin.perm.session",
  workwith: "plugin.perm.workwith",
  pagectl: "plugin.perm.pagectl",
  events: "plugin.perm.events",
  notify: "plugin.perm.notify",
  data: "plugin.perm.data",
  storage: "plugin.perm.storage",
  chaticon: "plugin.perm.chaticon",
  takeover: "plugin.perm.takeover",
  exec: "plugin.perm.exec",
  write: "plugin.perm.write",
  files: "plugin.perm.files",
  net: "plugin.perm.net",
};

export const permLabel = (t, perm) => (PERM_KEY[perm] ? t(PERM_KEY[perm]) : t("plugin.permUnknown"));
