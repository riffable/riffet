# Riffet 品牌资源

读音：Riffet，读 RIFF-it（/ˈrɪfɪt/），中文读「里菲特」。

## 文件

| 文件 | 内容 |
| --- | --- |
| `mark.svg` / `mark-dark.svg` | 标志：实心侧面马头，白眼（镂空），三齿圆角鬃毛画在马头后面 |
| `wordmark.svg` / `wordmark-dark.svg` | 字标：大写 R（腿从碗底中段斜出）、带点的 i、两个各有横笔的 f、e、带钩的 t |
| `lockup.svg` / `lockup-dark.svg` | 横版组合：马在左，字标在右 |
| `avatar.svg/png` / `avatar-dark.svg/png` | 头像：1024 满铺方形，马在中心，圆形裁切后不缺角 |
| `preview.html` | 各尺寸、浅深两套与各端图标的对照 |

深色文件给深色背景用。眼睛是镂空，露出背景色。

## 颜色

- 墨 `#15171A`：浅色背景上的马头与字标
- 纸 `#F4F2EE`：深色背景上的马头与字标
- 鬃毛蓝 `#3867F0`：浅色背景上的鬃毛；深色图标底上用各端的强调色（默认 `#5B8CFF`）

## 组合规则

字标在垂直方向上以马头外框居中；字标缩放为马的 0.6125 倍，与马的间距为 27.25 个单位（马在 24 单位网格上）。

## 最小尺寸

标志不小于 16 px；组合中字标高度不小于 12 px，再小只用标志。

## 生成

`pnpm gen:brand` 由 `scripts/gen-brand.ts` 一次生成本目录的 SVG，以及 Web 图标、macOS、iOS（含深色与着色）、Android 自适应图标。改动只在这个脚本里做，生成的文件和各端代码里的标志副本（`lib/app-icon.ts`、`RiffetIcons`、`BrandMark`）一起提交。
