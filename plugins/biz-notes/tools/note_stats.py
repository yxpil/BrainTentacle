# 便签统计：解释器的工作目录是 BIT toolhomes，插件数据目录就在 plugin_data/<插件id>/。
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.join("plugin_data", "biz-notes")


def main():
    if not os.path.isdir(ROOT):
        print(json.dumps({"ok": True, "notes": 0, "dirs": {}, "words": 0, "summary": "便签本还是空的"}, ensure_ascii=False))
        return

    per_dir = {}
    words = 0
    notes = 0
    for base, _dirs, files in os.walk(ROOT):
        rel = os.path.relpath(base, ROOT).replace("\\", "/")
        key = "." if rel == "." else rel
        for name in files:
            if not name.endswith(".md"):
                continue
            try:
                with open(os.path.join(base, name), encoding="utf-8") as f:
                    text = f.read()
            except Exception as exc:
                per_dir.setdefault(key, {"notes": 0, "words": 0, "error": str(exc)})
                continue
            notes += 1
            w = len(text)
            words += w
            bucket = per_dir.setdefault(key, {"notes": 0, "words": 0})
            bucket["notes"] += 1
            bucket["words"] += w

    print(
        json.dumps(
            {
                "ok": True,
                "root": os.path.abspath(ROOT),
                "notes": notes,
                "words": words,
                "dirs": dict(sorted(per_dir.items())),
                "summary": f"{notes} 张便签、{words} 字，分布在 {len(per_dir)} 个目录",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
