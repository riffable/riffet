# S3 分享

`sharePublisher` 扩展点的参考实现：把会话分享（见 [docs/SHARES.md](../../docs/SHARES.md)）发布到 S3 兼容的对象存储，如 AWS S3、Cloudflare R2、MinIO。请求用 `node:crypto` 做 AWS Signature V4 签名，不依赖 AWS SDK。

## 信任

分享发布插件运行在 Riffet 服务端进程内，所以必须以明确信任安装。插件读取设置里的访问密钥，只向你配置的端点发请求。

```sh
riffet plugin pack official/share-s3 --out /tmp/riffet-share-s3.tgz
riffet plugin install /tmp/riffet-share-s3.tgz --trusted --yes
```

## 设置

| 设置 | 含义 |
|---|---|
| 端点 | S3 API 的 `https` 地址（仅 localhost 可用 `http`） |
| 区域 | 签名区域；R2 填 `auto` |
| 存储桶、键前缀 | 分享写入的位置；前缀可选 |
| 寻址方式 | 路径式（默认，MinIO 需要）或虚拟主机式 |
| 公开基础地址 | 存储桶根目录对外的地址：网站端点、CDN 或 R2 公开域名 |
| 访问密钥 ID、私有访问密钥 | 需要 `GetObject`、`PutObject`、`DeleteObject`、`ListBucket` |

私有访问密钥由 Riffet 作为插件密钥保存，不会发给客户端。

## 存了什么

- `<前缀>/<别名>/...`：分享包。页面地址是 `<公开基础地址>/<前缀>/<别名>/index.html`，不要求托管方支持目录索引。
- `<前缀>/.meta/<别名>.json`：内容哈希、发布时间、到期时间和发布所用的存储桶。先于文件写入、后于文件删除，发布或撤销中断后仍能找到并继续处理。

存储桶需要公开读取 `<前缀>/<别名>/`；桶策略允许时让 `.meta/` 保持私有。拿到链接的人都能打开页面。

## 到期

Riffet 只记录到期时间，不会删除过期分享。本插件把超过 `expiresAt` 的分享视为已不存在（`find`、`verify` 不再返回），并在下次查询时删除其对象；Riffet 运行且插件被检查时，还会每小时清理一次（每次最多 50 个）。清理发生前页面仍可访问。需要硬性期限时，在该前缀上加存储桶生命周期规则。

## 限制

- 身份是存储桶加端点；改动其中任何一个，之前的分享就无法再从 Riffet 管理。
- 尚未对真实的 S3、R2、MinIO 验证：签名器与 AWS 公布的测试向量一致，请求流程只用本地替身服务验证过。
