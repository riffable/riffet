import manifest from './riffet-plugin.json';
// Publishes shared conversations (docs/SHARES.md) to S3-compatible object storage: AWS S3, Cloudflare R2, MinIO.
// Requests are signed with AWS Signature V4 by `s3.ts`; the access keys stay in this plugin's settings.

import { type Plugin, type PluginHost, type PluginPage, type PluginPageItem } from '@riffet/plugin-api';
import { S3SharePublisher } from './publisher.js';

const publishers = new WeakMap<PluginHost, S3SharePublisher>();
function publisher(host: PluginHost): S3SharePublisher {
  let value = publishers.get(host);
  if (!value) publishers.set(host, value = new S3SharePublisher(host));
  return value;
}

function page(host: PluginHost, locale: string): PluginPage {
  const zh = locale.toLowerCase().startsWith('zh');
  const text = (en: string, cn: string) => (zh ? cn : en);
  const settings = host.settings();
  const field = (key: string, en: string, cn: string, placeholder?: string): PluginPageItem =>
    ({ kind: 'text', key, label: text(en, cn), value: settings[key] ?? '', ...(placeholder ? { placeholder } : {}) });
  return { sections: [
    { id: 'storage', title: text('Storage', '存储'), items: [
      field('endpoint', 'Endpoint', '端点', 'https://s3.us-east-1.amazonaws.com'),
      field('region', 'Region', '区域', 'us-east-1'),
      field('bucket', 'Bucket', '存储桶'),
      field('prefix', 'Key prefix', '键前缀', 'riffet'),
      { kind: 'choice', key: 'addressing', label: text('Addressing', '寻址方式'), value: settings.addressing === 'virtual' ? 'virtual' : 'path', options: [
        { value: 'path', label: text('Path style', '路径式') }, { value: 'virtual', label: text('Virtual-hosted', '虚拟主机式') },
      ] },
    ] },
    { id: 'access', title: text('Access key', '访问密钥'), footer: text('Stored on this server only', '仅保存在这台服务器'), items: [
      field('accessKeyId', 'Access key ID', '访问密钥 ID'),
      { kind: 'text', key: 'secretAccessKey', label: text('Secret access key', '私有访问密钥'), secret: true, set: Boolean(host.secrets.get('secretAccessKey')) },
    ] },
    { id: 'public', title: text('Public address', '公开地址'), items: [
      field('publicBaseUrl', 'Public base URL', '公开基础地址', 'https://share.example.com'),
      { kind: 'buttons', buttons: [{ action: 'test', label: text('Test connection', '测试连接') }] },
    ] },
  ] };
}

export const shareS3: Plugin = {
  manifest: manifest as Plugin['manifest'],
  activate: host => ({
    sharePublisher: publisher(host),
    page: {
      read: context => page(host, context.locale),
      async run(_context, action) {
        if (action !== 'test') return;
        await publisher(host).test();
        return { message: 'OK' };
      },
    },
  }),
};

export default shareS3;
