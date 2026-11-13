import { memo } from 'react';
import { useMessages } from '@riffet/plugin-web';
import { trackLine, type FlowEdge, type FlowLayout } from './flow';
import { IconArrowsInLineHorizontal, IconFolderClosed, IconGitBranch } from './icons';
import { catalogs } from './messages';

/*
 * What a conversation happened in, drawn under it: the project frame around each row, each turn's
 * time above its column, the silences between turns, each track's line, and the seams where the
 * context was compacted.
 */

const DAY = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

export const Frames = memo(function Frames({ frames, far }: { frames: FlowLayout['frames']; far: boolean }) {
  return (
    <>
      {frames.map((frame) => (
        <div key={frame.id} className="pointer-events-none absolute rounded-[26px] border border-fg/[0.06] bg-[var(--canvas-paper)] transition-[width,height] duration-[var(--duration-slow)] ease-out-soft motion-reduce:transition-none" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
          {!far && frame.project && (
            <span className="absolute left-5 top-0 flex -translate-y-1/2 items-center gap-1.5 rounded-full border border-fg/[0.06] bg-[var(--canvas-paper)] px-2.5 py-0.5 text-[11px] text-fg-3">
              <IconFolderClosed className="size-3 text-fg-4" />
              <span className="max-w-56 truncate">{frame.project}</span>
              {frame.branch && <><IconGitBranch className="ml-1 size-3 text-fg-4" /><span className="max-w-40 truncate font-mono text-[10.5px]">{frame.branch}</span></>}
            </span>
          )}
        </div>
      ))}
    </>
  );
});

/** When each turn began, above its column; the date where a new day starts. */
export const Gutter = memo(function Gutter({ marks, cutoff }: { marks: FlowLayout['gutter']; cutoff: number }) {
  return (
    <>
      {marks.filter((mark) => mark.t <= cutoff).map((mark) => (
        <span key={mark.id} className="pointer-events-none absolute flex items-baseline gap-1.5 whitespace-nowrap font-mono text-[10.5px] leading-[14px] tabular-nums text-fg-4" style={{ left: mark.x + 2, top: mark.y }}>
          {mark.day && <span className="text-fg-3">{DAY.format(mark.t)}</span>}
          <span>{CLOCK.format(mark.t)}</span>
        </span>
      ))}
    </>
  );
});

/** A long silence between two turns, said once on the edge that spans it. */
export const Silences = memo(function Silences({ edges }: { edges: FlowEdge[] }) {
  const m = useMessages(catalogs);
  const say = (ms: number) => {
    const hours = ms / 3_600_000;
    if (hours >= 24) return m.daysLater(Math.round(hours / 24));
    if (hours >= 1) return m.hoursLater(Math.round(hours));
    return m.minutesLater(Math.round(ms / 60_000));
  };
  return (
    <>
      {edges.filter((edge) => edge.gap && edge.mid).map((edge) => (
        <span key={edge.id} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-line-soft bg-[var(--canvas-paper)] px-2 py-px text-[10.5px] text-fg-4" style={{ left: edge.mid![0], top: edge.mid![1] }}>
          {say(edge.gap!)}
        </span>
      ))}
    </>
  );
});

/** Each track's line, through its marks, bars or cards' heads, so a track reads as a timeline between them. */
export const TrackLines = memo(function TrackLines({ tracks }: { tracks: FlowLayout['tracks'] }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
      {tracks.map((track) => {
        const y = track.y + trackLine(track);
        return <line key={track.id} x1={track.x} x2={track.x + track.w} y1={y} y2={y} stroke="var(--fg)" strokeOpacity={0.08} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray={track.external ? '3 4' : undefined} />;
      })}
    </svg>
  );
});

/** Where the context was compacted: a dashed seam down the row, and mid-turn, its size before and after at the top. */
export const Seams = memo(function Seams({ seams, cutoff, far }: { seams: FlowLayout['seams']; cutoff: number; far: boolean }) {
  const shown = seams.filter((seam) => seam.t <= cutoff);
  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
        {shown.map((seam) => <line key={seam.id} x1={seam.x} x2={seam.x} y1={seam.top} y2={seam.bottom} stroke="var(--fg)" strokeOpacity={0.22} strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />)}
      </svg>
      {!far && shown.filter((seam) => seam.tokens).map((seam) => (
        <span key={seam.id} className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-line-strong bg-[var(--canvas-paper)] px-1.5 py-px font-mono text-[10px] tabular-nums text-fg-4" style={{ left: seam.x, top: seam.top }}>
          <IconArrowsInLineHorizontal className="size-3" />{seam.tokens}
        </span>
      ))}
    </>
  );
});
