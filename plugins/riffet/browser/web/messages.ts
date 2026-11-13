import type { MessageCatalogs } from '@riffet/plugin-web';

// The browser panel's own text (docs/BROWSER.md §5); `zh-Hans` is the source and `en` follows its keys.

const zhHans = {
  back: '后退',
  forward: '前进',
  reload: '刷新',
  address: '地址',
  closeTab: '关闭标签页',
  done: '完成',
  allow: '允许',
  deny: '拒绝',
  notInstalled: '需要先选择或下载浏览器',
  openSettings: '打开设置',
  category: { send: '发送', submit: '提交', delete: '删除', order: '下单', pay: '付款' },
};
type Messages = typeof zhHans;

const en: Messages = {
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  address: 'Address',
  closeTab: 'Close tab',
  done: 'Done',
  allow: 'Allow',
  deny: 'Deny',
  notInstalled: 'Choose or download a browser first',
  openSettings: 'Open settings',
  category: { send: 'Send', submit: 'Submit', delete: 'Delete', order: 'Order', pay: 'Pay' },
};

export const catalogs: MessageCatalogs<Messages> = { 'zh-Hans': zhHans, en };
