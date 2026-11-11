/** Identity captured once when a program is built, independent of the current checkout. */
export interface BuildInfo {
  version: string;
  buildNumber: number;
  tag: string | null;
  commit: string | null;
  dirty: boolean;
}

export interface ReleaseTag {
  tag: string;
  version: string;
  /** Peeled commit, including for annotated tags. */
  commit: string;
  /** Remote tag object; equals commit for a lightweight tag. */
  objectId: string;
}

export interface SourceInfo {
  commit: string | null;
  tag: string | null;
  dirty: boolean;
}

/** Public result deliberately excludes local paths and Git remote URLs/credentials. */
export interface UpdateCheck {
  status: 'available' | 'current' | 'ahead' | 'development' | 'unavailable' | 'no-releases' | 'conflict';
  current: BuildInfo;
  latest: ReleaseTag | null;
  source: SourceInfo | null;
  message?: string;
}
