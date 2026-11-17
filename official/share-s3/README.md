# S3 Share

The reference implementation of the `sharePublisher` extension point: publishes shared conversations (see [docs/SHARES.md](../../docs/SHARES.md)) to S3-compatible object storage such as AWS S3, Cloudflare R2 and MinIO. Requests are signed with AWS Signature V4 using `node:crypto`; there is no AWS SDK dependency.

## Trust

Share publishers run in the Riffet server process, so this package must be installed with explicit trust. It reads the access key from its settings and sends requests to the endpoint you configure; nothing else.

```sh
riffet plugin pack official/share-s3 --out /tmp/riffet-share-s3.tgz
riffet plugin install /tmp/riffet-share-s3.tgz --trusted --yes
```

## Settings

| Setting | Meaning |
|---|---|
| Endpoint | `https` address of the S3 API (`http` only for localhost) |
| Region | Signing region; `auto` for R2 |
| Bucket, Key prefix | Where shares are written; the prefix is optional and uses letters, digits and `. _ - /` |
| Addressing | Path style (default, needed by MinIO) or virtual-hosted |
| Public base URL | Where the bucket root is served from: a website endpoint, CDN or R2 public domain |
| Access key ID, Secret access key | Need `GetObject`, `PutObject`, `DeleteObject`, `ListBucket` |

The secret access key is stored by Riffet as a plugin secret and is never sent to clients.

## What is stored

- `<prefix>/<alias>/...`: the share package. The page is `<public base URL>/<prefix>/<alias>/index.html`, so the host does not need directory-index support.
- `<prefix>/.meta/<alias>.json`: content hash, publish time, expiry and the publishing bucket. Written before the files, removed after them, so an interrupted publish or removal can still be found and finished.

The bucket must serve `<prefix>/<alias>/` publicly; keep `.meta/` private if the bucket policy allows it. Anyone with the link can open a page.

## Expiry

Riffet records the expiry but does not delete expired shares. This plugin treats a share past `expiresAt` as gone (`find` and `verify` stop reporting it) and deletes its objects when it is next looked up, and in an hourly sweep (up to 50 shares, continuing where the last one stopped) while Riffet is running and the plugin is checked. A page stays reachable until one of those runs. For a hard limit, add a bucket lifecycle rule on the prefix.

## Limits

- Identity is the bucket and endpoint; changing either makes earlier shares unmanageable from Riffet.
- Not verified against a real S3, R2 or MinIO yet: the signer matches the published AWS test vectors, and the request path is exercised against a local stand-in.
