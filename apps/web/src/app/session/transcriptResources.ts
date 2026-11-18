import { createContext, useContext } from 'react';
import type { ShareModelInfo, ShareResource } from '@contracts';

/** Reading data supplied by a frozen transcript, instead of the workbench's local services. */
export interface TranscriptResources {
  resources: Record<string, ShareResource>;
  blobs: Record<string, string>;
  diagramPages: Record<string, string>;
  contentPage?: string;
  modelInfo?: Record<string, ShareModelInfo>;
  /** Model key shared by every exported answer when uniform, so per-turn footers need not repeat it. */
  commonModelKey?: string;
}

export function shareModelLabel(info: ShareModelInfo): string {
  return [info.model, info.reasoningEffort, info.fast ? 'Fast' : undefined, info.serviceTier].filter(Boolean).join(' · ');
}

export function shareModelKey(info: ShareModelInfo): string {
  return JSON.stringify([info.model, info.reasoningEffort ?? null, info.fast ?? null, info.serviceTier ?? null]);
}

export const TranscriptResourcesContext = createContext<TranscriptResources | undefined>(undefined);
export const useTranscriptResources = () => useContext(TranscriptResourcesContext);
