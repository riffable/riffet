# 步骤（device_act）
- tap / long_press：{action, ref} 或 {action, x, y}（0–999）。优先用 ref；只有没有节点的东西才用坐标。
- type：{action: "type", text, ref?, submit?}。替换字段的内容（不传 ref 时是当前有焦点的字段）并读回核对：verified 一致 | mismatch 不一致 | unknown 未知。submit: true 随后按下键盘的回车 / 发送键。
- swipe：{action, direction, ref?}：手指移动的方向，在 ref 内或屏幕中部。scroll：{action, direction, ref?}：你要的内容所在的方向（down = 更下面的内容），在 ref 内或最大的可滚动区域里。
- back、home：系统按键。wait_stable：{action, timeoutMs?}：等到屏幕静止 500 毫秒（默认 3000，最大 10000）；在启动应用后和会加载内容的步骤后使用。
- 步骤按顺序执行；第一个失败会停下整批：stoppedAt 是它从 0 开始的序号，后面的步骤没有执行，工具结果是以 "CODE: message" 开头的错误。
- 步骤结果：{action, ok: true, effect, verified?, target?, category?, authorizedBy?} 或 {action, ok: false, code, message?}。
- effect：place_changed（另一个应用或页面到了前台）、done（屏幕变了）、small_change（最多 3 个节点变化，例如填了一个字段）、no_effect（什么都没变：很可能没点中；重新观察，不要盲目重复）。
- observe: true 在这批步骤后附上屏幕（相对上一次的 diff），省一次 device_observe。
- category 标出不可撤销的步骤（send、delete、submit…）；authorizedBy 说明它为什么被执行：policy（用户允许这个应用）、owner（刚在手机上确认）或 grant:<id>。
