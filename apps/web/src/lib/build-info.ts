import type { BuildInfo } from '@contracts';

declare const __RIFFET_WEB_BUILD__: BuildInfo;

/** This browser bundle keeps its own identity even after source or Server updates. */
export const WEB_BUILD: BuildInfo = Object.freeze(typeof __RIFFET_WEB_BUILD__ === 'undefined'
  ? { version: 'unknown', buildNumber: 0, tag: null, commit: null, dirty: true }
  : { ...__RIFFET_WEB_BUILD__ });
