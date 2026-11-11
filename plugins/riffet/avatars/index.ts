// 头像风格 (docs/OWNER.md「随机头像」): the styles the personal info offers as generated avatars. It has no
// state and no settings; turning it off removes its styles from the list, and an avatar already made stays,
// because the core stores the picture, not the style.

import { PLUGIN_API_VERSION, type AvatarStyleProvider, type Plugin } from '@riffet/plugin-api';
import { DICEBEAR_STYLES, creditOf, diceBearProvider } from './dicebear.js';
import { sealProvider } from './seal.js';

const ID = 'riffet.avatars';

export const avatars: Plugin = {
  manifest: {
    id: ID, vendor: 'riffet', name: 'avatars', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '1.0.0',
    title: { 'zh-Hans': '头像风格', en: 'Avatar styles' },
    description: { 'zh-Hans': '个人资料里的随机头像风格。', en: 'Generated avatar styles for the personal info.' },
    contributes: {
      avatarStyles: [
        ...DICEBEAR_STYLES.map(style => ({ id: `${ID}/${style.name}`, title: { 'zh-Hans': style.title, en: style.title }, credit: creditOf(style) })),
        { id: `${ID}/seal`, title: { 'zh-Hans': '印章', en: 'Seal' }, needsName: true },
      ],
    },
  },
  activate: () => ({
    avatarStyles: {
      ...Object.fromEntries(DICEBEAR_STYLES.map((style): [string, AvatarStyleProvider] => [`${ID}/${style.name}`, diceBearProvider(style)])),
      [`${ID}/seal`]: sealProvider,
    },
  }),
};
