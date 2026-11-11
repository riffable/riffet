import type { CSSProperties } from 'react';
import { AGENT_ICON_ROUTE, isPluginAgentId } from '@contracts';
import { usePlugins } from '@/lib/plugins';
import { AgentMark } from './agent-marks';
import { IconBot } from './icons';

/**
 * An Agent's mark. A built-in id keeps its generated mark; a plugin's Agent draws the SVG its
 * plugin declares (as an image, never inline markup) and otherwise a generic glyph.
 */
export function AgentLogo({ backend, size = 14, className, style }: { backend: string; size?: number; className?: string; style?: CSSProperties }) {
  const declared = usePlugins();
  if (!isPluginAgentId(backend)) return <AgentMark backend={backend} size={size} className={className} style={style} />;
  const icon = declared?.flatMap((item) => item.declared?.agentBackends ?? []).find((item) => item.id === backend)?.icon;
  return icon?.svg
    ? <img src={AGENT_ICON_ROUTE(backend)} width={size} height={size} alt="" draggable={false} className={className} style={style} />
    : <IconBot className={className} style={{ width: size, height: size, ...style }} />;
}
