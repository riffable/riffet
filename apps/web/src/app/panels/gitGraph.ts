/**
 * Lays a list of commits (newest first, each naming its parents) out as the lanes of a graph.
 *
 * A lane is a column reserved for the commit a line is heading to. Each row records the lanes that
 * cross it and the lines that meet at its own commit, so a row can be drawn on its own and rows
 * stack into continuous lines.
 */
export interface GraphRow {
  /** The lane the commit sits in. */
  column: number;
  color: number;
  /** Lanes above the commit that end at it: its own, and those of branches that started from it. */
  from: Array<{ column: number; color: number }>;
  /** Lanes the commit's lines leave to, one per parent. */
  to: Array<{ column: number; color: number }>;
  /** Lanes that pass the commit by. */
  through: Array<{ column: number; color: number }>;
  /** How many lanes the row is wide. */
  width: number;
}

export function layoutGraph(commits: Array<{ hash: string; parents: string[] }>): GraphRow[] {
  const lanes: Array<{ hash: string; color: number } | undefined> = [];
  let colors = 0;
  const free = () => { const index = lanes.indexOf(undefined); return index === -1 ? lanes.length : index; };
  return commits.map((commit) => {
    const arriving = lanes.flatMap((lane, index) => (lane?.hash === commit.hash ? [index] : []));
    const column = arriving[0] ?? free();
    const color = lanes[column]?.color ?? colors++;
    const from = arriving.map((index) => ({ column: index, color: lanes[index]!.color }));
    const through = lanes.flatMap((lane, index) => (lane && lane.hash !== commit.hash ? [{ column: index, color: lane.color }] : []));
    const before = lanes.length;
    for (const index of arriving) lanes[index] = undefined;
    const to = commit.parents.map((parent, order) => {
      const known = lanes.findIndex((lane) => lane?.hash === parent);
      if (known !== -1) return { column: known, color: lanes[known]!.color };
      // The first parent carries the commit's own line on; any other is a branch merged in here.
      const slot = order === 0 ? column : free();
      lanes[slot] = { hash: parent, color: order === 0 ? color : colors++ };
      return { column: slot, color: lanes[slot]!.color };
    });
    while (lanes.length && lanes.at(-1) === undefined) lanes.pop();
    return { column, color, from, to, through, width: Math.max(before, lanes.length, column + 1) };
  });
}
