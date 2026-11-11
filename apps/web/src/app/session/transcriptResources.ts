import { createContext, useContext } from 'react';
import type { ShareResource } from '@contracts';

/** Reading data supplied by a frozen transcript, instead of the workbench's local services. */
export interface TranscriptResources {
  resources: Record<string, ShareResource>;
  blobs: Record<string, string>;
  diagramPages: Record<string, string>;
  contentPage?: string;
}

export const TranscriptResourcesContext = createContext<TranscriptResources | undefined>(undefined);
export const useTranscriptResources = () => useContext(TranscriptResourcesContext);
