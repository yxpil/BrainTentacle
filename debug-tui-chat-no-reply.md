# [CLOSED] tui-chat-no-reply

## 症状
用户运行 `bit tui`（plain 模式），输入 `hi` 后无 AI 回复、无错误提示。

## 根因
**用户的 API key 过期/无效**（HTTP 401）。

## 验证证据
```
[tui-plain] block_on entered
[tui-plain] got line: "hi"
[tui-handle] chat_turn_auto sid=dbc7ad4c before_msgs=200
[chat_turn] round=1 native_mode=true convo.len=97
[tui-plain] handle error: HTTP 401 Unauthorized: {"error":{"message":"Authentication Fails, Your api key: ****73ac is invalid"...}}
```

TUI 链路完全正常：
- block_on（tokio runtime）✅
- chat_turn_auto → chat_turn → chat_native_round_stream ✅
- sessions 历史加载 ✅（before_msgs=200, convo.len=97）
- 错误正确返回给 plain.rs 并打印到 stdout ✅

## 用户看到"无回复"原因
用户那次运行时可能是 **旧版本**（0.6.18）或 stderr 被 start /b 吞掉。0.6.19 plain.rs 错误路径会 `println!("错误：{e}")` 到 stdout。

## 清理
所有插桩 println!/eprintln! 已移除，代码干净。

## 建议
用户在 GUI 的 AI 设置里更新 API key 即可。
