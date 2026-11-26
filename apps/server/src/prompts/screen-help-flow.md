# 典型流程：在聊天应用里发消息（例如微信，com.tencent.mm）
1. device_launch_app {name: "微信"}，然后 device_act {steps: [{action: "wait_stable"}], observe: true}。有些手机装着同一个应用的第二份（应用分身 / 双开），打开前会先问开哪一个：用户没说的话，先问而不是猜；显示登录界面的那一份不是在用的。
2. 打开聊天：点联系人，或者点搜索入口、输入名字、点结果。确认聊天标题是对的人。
3. device_act {steps: [{action: "type", ref: <输入框>, text: <消息>}, {action: "tap", ref: <发送按钮>}], observe: true}；确认 type 的核对结果是 verified，消息也出现了。很多聊天应用要输入文字后才显示发送按钮：还没有发送按钮时，先用 observe: true 输入，再点新出现的 ref。
4. 点发送是不可撤销的：手机可能会请用户确认（调用会等待），除非有匹配的预先授权。
- 定时或无人值守的发送：趁用户还在，例如就在调用 schedule_wakeup 时，调用 device_authorize {app: "com.tencent.mm", action: "send", summary: "微信给张三发送「晚上七点见」", content: "晚上七点见", validMinutes: <到唤醒时间稍后一点>}。之后输入的内容必须与之完全一致；其他文字不匹配这次授权。
- 绝不支付、转账或发红包：这类步骤会返回 DEVICE_HANDOFF_REQUIRED，必须由用户自己做。告诉用户；不要另找办法。
