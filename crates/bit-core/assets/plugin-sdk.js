// yxpil · 插件页面 SDK（由插件 API 服务原样下发，静态页自动注入）
//
// 插件页面跑在独立 iframe 里，与宿主不同源、无 node，唯一通道是 postMessage 桥。
// 每条消息都带本插件的通讯令牌：宿主既认"这个帧是我创建的"，也认"它带着我发给它的凭据"，
// 两者缺一律拒绝——手册的建议是不带凭据的通道不要开口。
// 令牌来源（按优先级）：帧地址的 ?bit_token=（静态页，服务端校验后才发 HTML）、
// #bit_token=（动态页唯一途径）或注入脚本里的 __BIT_PLUGIN_TOKEN__。
// 片段取完就抹掉，免得页面自己的代码/log 把它抄走；查询参数保留，刷新页面仍能过服务端校验。
// 宿主侧再按该插件的权限位放行：未声明的能力直接回错误。
// 协议：帧 → 宿主 { bit, id, token, payload }；宿主 → 帧 { bitPlugin:'bit', id, payload|error|event }。
(function () {
  "use strict";
  var pending = {},
    listeners = [],
    seq = 0,
    info = null,
    token = "";

  // 握手回执要等一次帧往返才有，页面在 boot 里直接读 info() 必然拿到 null。
  // ready() 给出一个确定能落地的等待点：连不上宿主时超时也 resolve(null)，不把页面吊死。
  var readyResolve = null;
  var readyPromise = new Promise(function (resolve) {
    readyResolve = resolve;
    setTimeout(function () {
      resolve(null);
    }, 5000);
  });

  // 从 #bit_token=xxx 里取令牌并顺手抹掉片段（其它片段内容原样保留）
  function readHashToken() {
    var h = String(location.hash || "").replace(/^#/, "");
    if (!h) return "";
    var keep = [];
    var got = "";
    h.split("&").forEach(function (kv) {
      if (kv.indexOf("bit_token=") === 0) got = decodeURIComponent(kv.slice(10));
      else if (kv) keep.push(kv);
    });
    try {
      history.replaceState(null, "", location.pathname + location.search + (keep.length ? "#" + keep.join("&") : ""));
    } catch (e) {
      /* 沙箱里 replaceState 可能被拒：令牌已拿到，地址栏留着也不影响通话 */
      void e;
    }
    return got;
  }

  // 静态页：服务端要 ?bit_token= 才发 HTML，读出来给桥用
  function readQueryToken() {
    try {
      return new URL(location.href).searchParams.get("bit_token") || "";
    } catch (e) {
      return "";
    }
  }

  token = readQueryToken() || readHashToken() || String(window.__BIT_PLUGIN_TOKEN__ || "");

  function call(bit, payload) {
    return new Promise(function (resolve, reject) {
      var id = "b" + ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ bit: bit, id: id, token: token, payload: payload || {} }, "*");
    });
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.bitPlugin !== "bit") return;
    if (d.event) {
      emitToListeners(d);
      return;
    }
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.payload);
  });

  // 宿主转发的通用事件包在 {event:"host", payload:{name,data}} 里，
  // 具名订阅要能按内层事件名命中（"chat" 这类直推事件按外层名命中）
  function eventMatches(d, name) {
    if (d.event === name) return true;
    return d.event === "host" && !!d.payload && d.payload.name === name;
  }

  // 回调收到的都是"事件本身的数据"：host 事件取内层 data，其余取 payload
  function eventData(d) {
    if (d.event === "host" && d.payload) return d.payload.data;
    return d.payload;
  }

  function emitToListeners(d) {
    var drop = [];
    for (var i = 0; i < listeners.length; i++) {
      var slot = listeners[i];
      if (!slot.name || eventMatches(d, slot.name)) {
        try {
          slot.cb(eventData(d), d.event);
        } catch (err) {
          console.error(err);
        }
        if (slot.once) drop.push(slot);
      }
    }
    if (drop.length) listeners = listeners.filter(function (s) { return drop.indexOf(s) < 0; });
  }

  // 命名空间式包装：cap(verb, payload) 是唯一的能力出口，权限位由宿主逐条把关
  // 帧与 HTTP 两条通道同一种包法：{ verb, payload }，参数不跟 verb 平铺，免得两边字段含义漂移
  function cap(verb, payload) {
    return call("cap", { verb: verb, payload: payload || {} });
  }

  window.Bit = {
    /** 握手回执：{ plugin_id, plugin_name, permissions, api }；握手未完成时为 null */
    info: function () {
      return info;
    },
    /** 等握手：resolve 值就是回执（连不上宿主时超时 resolve(null)），页面开局读身份请用 await Bit.ready() */
    ready: function () {
      return readyPromise;
    },
    /** 本插件的生效权限（握手完成后才有；`Bit.ready()` 之后读） */
    perms: [],
    /** 本插件身份（握手完成后填）：{id, name, api} */
    env: {},
    /** 订阅宿主转发的流式事件与宿主通知（chat 增量、被转发的宿主事件）；返回取消订阅函数
     *  on(cb)            全事件（老写法，回调收 (event, payload)）
     *  on(name, cb)      只收这一个事件，回调直接拿事件数据
     *  once(name, cb)    收到一次就自动退订 */
    on: function (nameOrCb, maybeCb) {
      var slot = typeof nameOrCb === "function" ? { name: "", cb: nameOrCb } : { name: String(nameOrCb || ""), cb: maybeCb };
      listeners.push(slot);
      return function () {
        listeners = listeners.filter(function (s) {
          return s !== slot;
        });
      };
    },
    /** 具名订阅一次（语法糖，等价于 on(name, cb) + 自动退订） */
    once: function (name, cb) {
      var slot = { name: String(name || ""), cb: cb, once: true };
      listeners.push(slot);
      return function () {
        listeners = listeners.filter(function (s) {
          return s !== slot;
        });
      };
    },
    /** 开局：握手完成后跑一次，失败也跑（info 为 null），页面不必自己写 ready().then 的样板
     *  Bit.boot(function (info) { ... }) */
    boot: function (fn) {
      return readyPromise.then(function (r) {
        try {
          fn && fn(r);
        } catch (e) {
          console.error(e);
        }
        return r;
      });
    },
    /** 这条权限现在是否生效（清单申报 ∧ 用户没单独关掉） */
    can: function (perm) {
      var ps = (info && info.permissions) || [];
      return ps.indexOf(perm) >= 0 || ps.indexOf("all") >= 0;
    },
    /** 对话：opts = { session_id?, new?, images? }，resolve 为 { reply, session_id }（需 chat） */
    chat: function (message, opts) {
      var p = { message: message };
      if (opts) for (var k in opts) p[k] = opts[k];
      return call("chat", p);
    },
    /** 读本插件会话的历史消息（会话归属由宿主校验，需 chat） */
    history: function (sessionId) {
      return call("history", { session_id: sessionId || "" });
    },
    /** 后端命令：需插件声明 invoke 权限 */
    invoke: function (cmd, args) {
      return call("invoke", { cmd: cmd, args: args || {} });
    },
    /** 按插件隔离的存储（落在宿主 localStorage，键名带插件前缀；需 storage 权限） */
    storage: {
      get: function (k) {
        return call("storage", { op: "get", key: k }).then(function (r) {
          return r.value;
        });
      },
      set: function (k, v) {
        return call("storage", { op: "set", key: k, value: String(v) });
      },
      remove: function (k) {
        return call("storage", { op: "remove", key: k });
      },
      /** 存对象/数组：写出去是 JSON 字符串，读回来是原对象（解析不了就回 fallback） */
      getJSON: function (k, fallback) {
        return call("storage", { op: "get", key: k }).then(function (r) {
          var v = r && r.value;
          if (v === null || v === undefined || v === "") return fallback === undefined ? null : fallback;
          try {
            return typeof v === "object" ? v : JSON.parse(v);
          } catch (e) {
            return fallback === undefined ? null : fallback;
          }
        });
      },
      setJSON: function (k, v) {
        return call("storage", { op: "set", key: k, value: JSON.stringify(v) });
      },
    },
    /** 能力出口（其余分组都是它的包装）：verb 与所需权限位见 Bit.caps() */
    cap: cap,
    /** 本插件实际可用的能力动词（按申报的权限位过滤） */
    caps: function () {
      return cap("caps", {});
    },
    /** 设置项：值存在宿主里，按插件命名空间隔离（需 settings） */
    settings: {
      all: function () {
        return cap("settings.all", {}).then(function (r) {
          return r.values;
        });
      },
      get: function (key) {
        return cap("settings.get", { key: key }).then(function (r) {
          return r.value;
        });
      },
      set: function (key, value) {
        return cap("settings.set", { key: key, value: value });
      },
      /** 值可以是对象：宿主按原样存，读回来还是对象；不是对象时退回 fallback */
      getJSON: function (key, fallback) {
        return cap("settings.get", { key: key }).then(function (r) {
          var v = r && r.value;
          if (v === null || v === undefined || v === "") return fallback === undefined ? null : fallback;
          return v;
        });
      },
      setJSON: function (key, value) {
        return cap("settings.set", { key: key, value: value });
      },
    },
    /** 自己的数据目录（插件目录之外，写了不会触发篡改基线；需 data） */
    data: {
      list: function () {
        return cap("data.list", {});
      },
      read: function (path) {
        return cap("data.read", { path: path }).then(function (r) {
          return r.text;
        });
      },
      write: function (path, text) {
        return cap("data.write", { path: path, text: text });
      },
      remove: function (path) {
        return cap("data.remove", { path: path });
      },
      readJSON: function (path, fallback) {
        return cap("data.read", { path: path }).then(function (r) {
          try {
            return JSON.parse(r.text);
          } catch (e) {
            return fallback === undefined ? null : fallback;
          }
        });
      },
      writeJSON: function (path, value) {
        return cap("data.write", { path: path, text: JSON.stringify(value, null, 2) });
      },
    },
    /** 会话：只能碰 plugin:<本插件id> 命名空间（需 session） */
    sessions: {
      list: function () {
        return cap("session.list", {});
      },
      read: function (sessionId) {
        return cap("session.read", { session_id: sessionId || "" });
      },
      append: function (role, content, sessionId) {
        return cap("session.append", { role: role, content: content, session_id: sessionId || "" });
      },
      /** 唤醒：把一段话作为后台产物送回本插件的会话，让那边的 AI 下一轮看到它 */
      wake: function (sessionId, text) {
        return cap("session.wake", { session_id: sessionId, text: text });
      },
    },
    /** 托管服务：条目由宿主交给 WorkWith 引擎跑（需 workwith；也可在清单 services[] 里预先声明） */
    services: {
      list: function () {
        return cap("workwith.list", {});
      },
      /** name 决定条目 id（同名幂等覆盖）；program 可为插件目录内相对路径或绝对路径 */
      save: function (entry) {
        return cap("workwith.save", entry || {});
      },
      start: function (name) {
        return cap("workwith.start", { name: name });
      },
      stop: function (name) {
        return cap("workwith.stop", { name: name });
      },
      remove: function (name) {
        return cap("workwith.remove", { name: name });
      },
    },
    /** 清单里自带的服务器（需 server） */
    server: {
      status: function () {
        return cap("server.status", {});
      },
      start: function () {
        return cap("server.start", {});
      },
      stop: function () {
        return cap("server.stop", {});
      },
    },
    /** 控制台执行（需 exec）：command 走默认 shell；program 直接启动可执行文件；均返回 { code, stdout, stderr, timed_out, duration_ms } */
    exec: {
      run: function (command, opts) {
        var p = { command: command };
        if (opts) for (var k in opts) p[k] = opts[k];
        return cap("exec.run", p);
      },
      program: function (program, args, opts) {
        var p = { program: program, args: args || [] };
        if (opts) for (var k in opts) p[k] = opts[k];
        return cap("exec.run", p);
      },
      /** 具名解释器：少敲一次引号，也少抄一次路径。
       *  清单里写了 interpreters 的插件，只有声明过的解释器会被放行。 */
      node: function (args, opts) {
        return window.Bit.exec.program("node", args, opts);
      },
      python: function (args, opts) {
        return window.Bit.exec.program("python", args, opts);
      },
      powershell: function (args, opts) {
        return window.Bit.exec.program("powershell", args, opts);
      },
    },
    /** 本机解释器：写插件时最想知道"这台机器上有什么"，这条不要任何权限 */
    runtime: {
      list: function () {
        return cap("runtime.list", {}).then(function (r) {
          return r.runtimes || [];
        });
      },
      has: function (id) {
        return window.Bit.runtime.list().then(function (rs) {
          return rs.some(function (r) {
            return r.id === id;
          });
        });
      },
    },
    /** 本插件登记且当前生效的文件类型（需 files 权限）：[{ id, label, exts, paths, tool }] */
    files: {
      kinds: function () {
        return cap("files.kinds", {}).then(function (r) {
          return r.kinds || [];
        });
      },
    },
    /** 文件与程序修改（需 write）：路径可为绝对路径；相对路径以插件数据目录为基准 */
    fs: {
      list: function (path) {
        return cap("fs.list", { path: path || "" });
      },
      stat: function (path) {
        return cap("fs.stat", { path: path });
      },
      read: function (path, opts) {
        var p = { path: path };
        if (opts) for (var k in opts) p[k] = opts[k];
        return cap("fs.read", p).then(function (r) {
          return r.encoding === "base64" ? r.base64 : r.text;
        });
      },
      write: function (path, text, opts) {
        var p = { path: path, text: text };
        if (opts) for (var k in opts) p[k] = opts[k];
        return cap("fs.write", p);
      },
      append: function (path, text) {
        return cap("fs.append", { path: path, text: text });
      },
      remove: function (path, recursive) {
        return cap("fs.remove", { path: path, recursive: !!recursive });
      },
      mkdir: function (path) {
        return cap("fs.mkdir", { path: path });
      },
      move: function (from, to) {
        return cap("fs.move", { from: from, to: to });
      },
      readJSON: function (path, opts) {
        return window.Bit.fs.read(path, opts).then(function (t) {
          try {
            return JSON.parse(t);
          } catch (e) {
            return null;
          }
        });
      },
      writeJSON: function (path, value, opts) {
        return window.Bit.fs.write(path, JSON.stringify(value, null, 2), opts);
      },
    },
    /** 唤醒/切换宿主页面（需 pagectl）：page 可为内置页 id、"<插件id>:<页id>" 或 "settings" */
    openPage: function (page, section) {
      return call("page", { op: "open", page: page, section: section || "" });
    },
    /** 改自己某个已注册页面的标题（需 pagectl） */
    setTitle: function (pageId, label) {
      return call("page", { op: "title", page: pageId, label: label });
    },
    /** 发一条系统通知（需 notify） */
    notify: function (title, body) {
      return cap("notify", { title: title, body: body || "" });
    },
    /** 等一会儿（毫秒）：轮询宿主状态时少写一个 setTimeout 包装 */
    sleep: function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    },
  };

  call("ready")
    .then(function (r) {
      info = r;
      window.Bit.perms = (r && r.permissions) || [];
      window.Bit.env = { id: (r && r.plugin_id) || "", name: (r && r.plugin_name) || "", api: (r && r.api) || "" };
      readyResolve(r);
      // 申报了 events 才订阅：宿主按权限位决定要不要把事件转进帧里
      if (r && (r.permissions || []).indexOf("events") >= 0) call("watch", { on: true }).catch(function () {});
    })
    .catch(function () {
      readyResolve(null);
    });
})();
