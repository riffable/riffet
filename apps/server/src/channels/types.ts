/*
 * The contract between the channel core (`service.ts`, IM-agnostic) and each IM platform. The platform side is a
 * plugin's `contributes.imChannels` (docs/design/channels.md「插件化」); its types live in the plugin API.
 */
import type { ImChannelProvider } from '@riffet/plugin-api';
import type { ChannelKind, LocalizedText } from '../../../../packages/contracts/src/index.js';

export type {
  ActionReply, ChannelAccount, ChannelAccountIdentity, ChannelAddress, ChannelCardCapabilities, ChannelConnection, ChannelConnectionStatus, ChannelContext, ChannelFieldSpec, ChannelKind, ChannelProviderHints, ChannelProviderMeta, CommandPanelView,
  ImChannelProvider, InboundAction, InboundAttachment, InboundMessage, InteractionView, ModelPickerView, PanelView, ProjectPickerView,
  ProviderHealth, ProviderRegistration, ReplyAnchor, SentRef, SurfaceState, TurnFooter, TurnStep, TurnSurface, TurnView,
} from '@riffet/plugin-api';

/** A platform as the core uses it: the provider with the declaration id and title its accounts are stored under. */
export interface ChannelProvider extends ImChannelProvider { kind: ChannelKind; title?: LocalizedText }
