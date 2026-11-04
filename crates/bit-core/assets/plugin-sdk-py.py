# yxpil · 插件进程侧 SDK 的 Python 出口（宿主物化在 toolhomes/py/bit.py）
#
# 与 node 那份同一套词汇、同一种包法：cap(verb, payload) 是唯一的能力出口，
# 其余命名空间都是它的包装。宿主拉起插件的 python 服务/工具时会把
# toolhomes/py 追加进 PYTHONPATH，所以插件里 `import bit` 直接可用。
#
# 只用标准库（urllib），不挑环境：插件进程里 pip 装什么由插件自己决定，
# 宿主不假设任何第三方包存在。
#
# 权限仍然逐条把关：未申报的 verb 由宿主拒绝，抛 BitError，
# status=403 表示"去清单里申报权限"，400 表示"改参数"。
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"
DEFAULT_TIMEOUT = 120.0


def _env():
    api = (os.environ.get("BIT_PLUGIN_API") or "").rstrip("/")
    return {
        "id": os.environ.get("BIT_PLUGIN_ID") or "",
        "service": os.environ.get("BIT_PLUGIN_SERVICE") or "",
        "api": api,
        "port": int(os.environ.get("BIT_PLUGIN_PORT") or 0),
        "dir": os.environ.get("BIT_PLUGIN_DIR") or "",
        "token": os.environ.get("BIT_PLUGIN_TOKEN") or "",
        "perms": [p for p in (os.environ.get("BIT_PLUGIN_PERMS") or "").split(",") if p.strip()],
    }


env = _env()


class BitError(Exception):
    """status: 403=没申报权限，400=参数不对，0=本地就没发出去（缺凭据/超时）"""

    def __init__(self, message, status=0, verb=""):
        super().__init__(message)
        self.status = status
        self.verb = verb


def can(perm):
    """同步判断某条权限位当前是否生效（读宿主下发的环境）"""
    return perm in env["perms"] or "all" in env["perms"]


def log(*a):
    print("[%s]" % (env["service"] or env["id"] or "bit"), *a, flush=True)


def sleep(seconds):
    time.sleep(seconds)


def _request(method, pathname, obj=None, query=None, timeout=DEFAULT_TIMEOUT):
    if not env["api"]:
        raise BitError("缺少 BIT_PLUGIN_API / BIT_PLUGIN_TOKEN：只有宿主托管的插件进程才带凭据", 0, "")
    url = env["api"] + pathname
    if query:
        url = url + "?" + urllib.parse.urlencode(query)
    data = None
    headers = {}
    if env["token"]:
        headers["authorization"] = "Bearer " + env["token"]
    if obj is not None:
        data = json.dumps(obj).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # 连接被拒、超时、DNS 失败都归到这里，插件侧看到同一异常类型
        raise BitError("宿主调用失败: %s" % e, 0, "")


def _unwrap(status, text, verb):
    try:
        data = json.loads(text)
    except ValueError:
        raise BitError("宿主返回不是 JSON：%s" % text[:200], status, verb)
    if status >= 400:
        raise BitError((data or {}).get("error") or "HTTP %s" % status, status, verb)
    return data


def cap(verb, payload=None, timeout=DEFAULT_TIMEOUT):
    """能力调用：verb 与所需权限位见 caps()"""
    if not env["token"]:
        raise BitError("缺少 BIT_PLUGIN_API / BIT_PLUGIN_TOKEN：只有宿主托管的插件进程才带凭据", 0, "")
    st, text = _request("POST", "/cap", {"verb": verb, "payload": payload or {}}, None, timeout)
    return _unwrap(st, text, verb)


def info():
    return cap("info")


def caps():
    return cap("caps").get("caps") or []


def chat(message, session_id="", images=None, timeout=300.0):
    """让本插件的 AI 回答一句话；会话强制落在 plugin:<id> 命名空间（需 chat 权限）"""
    body = {"message": message}
    if session_id:
        body["session_id"] = session_id
    if images:
        body["images"] = images
    st, text = _request("POST", "/chat", body, None, timeout)
    return _unwrap(st, text, "chat")


def history(session_id=""):
    st, text = _request("GET", "/history", None, {"session_id": session_id or ""})
    return _unwrap(st, text, "history")


def notify(title, body=""):
    return cap("notify", {"title": title, "body": body or ""})


class _Settings:
    def all(self):
        return cap("settings.all").get("values") or {}

    def get(self, key):
        return cap("settings.get", {"key": key}).get("value")

    def set(self, key, value):
        return cap("settings.set", {"key": key, "value": value})

    def get_json(self, key, fallback=None):
        v = self.get(key)
        if v in (None, ""):
            return fallback
        if isinstance(v, (dict, list)):
            return v
        try:
            return json.loads(v)
        except ValueError:
            return fallback

    def set_json(self, key, value):
        return self.set(key, value)


class _Data:
    def list(self):
        return cap("data.list")

    def read(self, path):
        return cap("data.read", {"path": path}).get("text")

    def write(self, path, text):
        return cap("data.write", {"path": path, "text": text})

    def remove(self, path):
        return cap("data.remove", {"path": path})

    def read_json(self, path, fallback=None):
        try:
            return json.loads(self.read(path))
        except Exception:
            return fallback

    def write_json(self, path, value):
        return self.write(path, json.dumps(value, ensure_ascii=False, indent=2))


class _Fs:
    def list(self, path=""):
        return cap("fs.list", {"path": path or ""})

    def stat(self, path):
        return cap("fs.stat", {"path": path})

    def exists(self, path):
        return bool(self.stat(path).get("exists"))

    def read(self, path, **opts):
        r = cap("fs.read", dict({"path": path}, **opts))
        return r.get("base64") if r.get("encoding") == "base64" else r.get("text")

    def read_json(self, path, **opts):
        try:
            return json.loads(self.read(path, **opts))
        except Exception:
            return None

    def write(self, path, text, **opts):
        return cap("fs.write", dict({"path": path, "text": text}, **opts))

    def write_json(self, path, value, **opts):
        return self.write(path, json.dumps(value, ensure_ascii=False, indent=2), **opts)

    def append(self, path, text):
        return cap("fs.append", {"path": path, "text": text})

    def remove(self, path, recursive=False):
        return cap("fs.remove", {"path": path, "recursive": bool(recursive)})

    def mkdir(self, path):
        return cap("fs.mkdir", {"path": path})

    def move(self, frm, to):
        return cap("fs.move", {"from": frm, "to": to})


class _Sessions:
    def list(self):
        return cap("session.list").get("sessions") or []

    def read(self, session_id=""):
        return cap("session.read", {"session_id": session_id or ""})

    def append(self, role, content, session_id=""):
        return cap("session.append", {"role": role, "content": content, "session_id": session_id or ""})

    def wake(self, session_id, text):
        return cap("session.wake", {"session_id": session_id, "text": text})


class _Services:
    def list(self):
        return cap("workwith.list")

    def save(self, entry):
        return cap("workwith.save", entry or {})

    def start(self, name):
        return cap("workwith.start", {"name": name})

    def stop(self, name):
        return cap("workwith.stop", {"name": name})

    def remove(self, name):
        return cap("workwith.remove", {"name": name})


class _Server:
    def status(self):
        return cap("server.status")

    def start(self):
        return cap("server.start")

    def stop(self):
        return cap("server.stop")


class _Net:
    def connections(self):
        """本插件清单 connections[] 声明的外部 MCP 连接与实时状态（需 net 权限）。
        只回自己的声明，看不到别的插件，也拿不到密钥值。"""
        return cap("net.connections").get("connections") or []

    def connect(self, name):
        return cap("net.connect", {"name": name})

    def disconnect(self, name):
        return cap("net.disconnect", {"name": name})


class _Exec:
    def run(self, command, **opts):
        return cap("exec.run", dict({"command": command}, **opts))

    def program(self, program, args=None, **opts):
        return cap("exec.run", dict({"program": program, "args": args or []}, **opts))

    def node(self, args, **opts):
        return self.program("node", args, **opts)

    def python(self, args, **opts):
        return self.program("python", args, **opts)

    def powershell(self, args, **opts):
        return self.program("powershell", args, **opts)


class _Runtime:
    def list(self):
        """本机可用解释器（id/名称/版本/语言），不需要任何权限"""
        return cap("runtime.list").get("runtimes") or []

    def has(self, rid):
        return any(r.get("id") == rid for r in self.list())


class _Files:
    def kinds(self):
        """本插件登记且当前生效的文件类型（需 files 权限）：[{id,label,exts,paths,tool}]"""
        return cap("files.kinds").get("kinds") or []


settings = _Settings()
data = _Data()
fs = _Fs()
sessions = _Sessions()
services = _Services()
server = _Server()
net = _Net()
exec = _Exec()
runtime = _Runtime()
files = _Files()
