// Code Studio (docs/CODE-STUDIO.md): a workbench page for reading a large project as an IDE lays it out:
// modules, tabs, outline, go to class or symbol, definitions and usages. Its server side is the `code_*` agent tools (tools.ts, over
// `host.code`); files and navigation for the page come from the core's project routes (`/api/projects/:id/files`, `/code/*`), whose
// declarations index lives in `apps/server/src/workspace/symbols/`. Web only for now (docs/guide/mac-scope.md).

import { PLUGIN_API_VERSION, type Plugin } from '@riffet/plugin-api';
import { STUDIO_TOOL_GROUP, toolGroup } from './tools.js';

export const codeStudio: Plugin = {
  manifest: {
    id: 'riffet.code-studio', vendor: 'riffet', name: 'code-studio', apiVersion: PLUGIN_API_VERSION, defaultEnabled: true, version: '0.1.0',
    title: { 'zh-Hans': 'Code Studio', en: 'Code Studio' },
    description: { 'zh-Hans': '按模块浏览与编辑项目代码，支持分屏、多光标、跳转定义、查找引用与符号搜索，大型 Android 仓库无需 Android Studio。', en: 'Browse and edit a project’s code by module with split view, multi-cursor editing, go to definitions, find usages and symbol search, without opening Android Studio on a large repository.' },
    contributes: {
      agentTools: [{
        id: STUDIO_TOOL_GROUP, toolPrefix: 'code_',
        title: { 'zh-Hans': '代码索引', en: 'Code index' },
        description: { 'zh-Hans': '按类名与符号搜索、跳转定义、查找引用、读文件结构', en: 'Search classes and symbols, go to definitions, find usages, read a file’s structure' },
        icon: { sfSymbol: 'chevron.left.forwardslash.chevron.right' },
      }],
      views: [{
        id: 'riffet.code-studio/code-studio', title: { 'zh-Hans': 'Code Studio', en: 'Code Studio' }, icon: { sfSymbol: 'chevron.left.forwardslash.chevron.right' },
        locations: ['main'], defaultLocation: 'main', clients: ['web'], instances: 'single',
      }],
    },
  },
  activate: host => ({ agentTools: { [STUDIO_TOOL_GROUP]: toolGroup(host) } }),
};
