# 错误
- DEVICE_LOCKED：屏幕锁着或熄屏了。请用户解锁；不要循环重试。
- DEVICE_STOPPED：用户本人按了停止或触碰了屏幕（接管了）；60 秒内拒绝控制。结束任务并询问用户。
- DEVICE_HANDOFF_REQUIRED：这一步只能由用户本人做（支付）；手机已把屏幕交给用户。告诉用户；不要重试，也不要绕过。
- DEVICE_DENIED：用户拒绝了这一步或这次授权。不要重试同样的事；询问用户。
- DEVICE_NOT_ALLOWED：手机上的控制已关闭，或用户屏蔽了这个应用。
- DEVICE_CAPABILITY_MISSING：Riffet 的无障碍服务没开；请用户打开。
- DEVICE_FAILED：这一步无法执行（ref 已不在屏幕上、字段不可编辑…）；重新观察后调整。
- DEVICE_UNREACHABLE / DEVICE_TIMEOUT：手机没有连接，或没有及时响应。
