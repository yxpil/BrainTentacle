# 每日 09:00 快照任务：生成一份当日报价并落到 toolhomes，供 last_snapshot 工具与看板页回看。
# 任务没有 cap 通道，参数固定为 stdin 里的 {}；stdout 的 JSON 会进审计与后台唤回链路。
import json
import random
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

random.seed(int(time.time()) // 86400)  # 同一天内可复现，方便比对两次运行
SKUS = [("A101", 19.9), ("A205", 88.0), ("B310", 12.5), ("C777", 260.0), ("D004", 45.8)]

quotes = []
for sku, base in SKUS:
    drift = random.uniform(-0.22, 0.22)
    quotes.append({"sku": sku, "base": base, "price": round(base * (1 + drift), 2), "change": round(drift, 4)})

mean = sum(q["price"] for q in quotes) / len(quotes)
flagged = [q["sku"] for q in quotes if mean and abs(q["price"] - mean) / mean >= 0.15]
snap = {
    "written_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    "count": len(quotes),
    "mean": round(mean, 2),
    "flagged": flagged,
    "quotes": quotes,
}

with open("biz_pricewatch_daily.json", "w", encoding="utf-8") as f:
    json.dump(snap, f, ensure_ascii=False, indent=2)

print(json.dumps({"ok": True, "summary": f"已存当日快照：{len(quotes)} 条，复核 {len(flagged)} 个", "snapshot": snap}, ensure_ascii=False))
