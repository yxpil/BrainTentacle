import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

# 宿主把解释器工具的工作目录设成 BIT toolhomes，定时任务写的快照就在这里，
# 工具与任务因此能隔空接力（工具没有 cap 通道，靠文件传递状态）。
PATH = "biz_pricewatch_daily.json"
HEARTBEAT = "biz_pricewatch_heartbeat.json"


def read_json(name):
    """工作目录（toolhomes）里的任务产物；读不到就当作还没跑过。"""
    try:
        with open(name, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    beat = read_json(HEARTBEAT)
    snap = read_json(PATH)
    if snap is None:
        print(json.dumps({"ok": False, "error": f"还没有快照（{PATH} 不存在），等定时任务跑过一次", "heartbeat": beat}, ensure_ascii=False))
        return

    print(json.dumps({"ok": True, "source": PATH, "snapshot": snap, "heartbeat": beat}, ensure_ascii=False))


if __name__ == "__main__":
    main()
