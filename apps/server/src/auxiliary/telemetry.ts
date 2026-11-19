import type { AuxiliaryJobKind, AuxiliaryModelTransport, ModelProbePreset, NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { GatewayProtocol } from './gateway.js';

export interface AuxiliaryCallRecord {
  createdAt?: number;
  kind: AuxiliaryJobKind;
  preset?: ModelProbePreset;
  source: 'live' | 'probe';
  backendId: NativeBackendId;
  profileId: string;
  model: string;
  transport: AuxiliaryModelTransport;
  protocol?: GatewayProtocol;
  ok: boolean;
  authMs: number;
  ttftMs: number | null;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  reasoningChars: number;
  thinkingDetected: boolean;
  streaming: boolean;
  errorCode?: string;
  detail?: string;
}

export type AuxiliaryCallRecorder = (record: AuxiliaryCallRecord) => void;
