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
  /** The newest release's version where only a version is known (an npm install has no tag or commit to show). */
  latestVersion?: string;
  /** When this result was found; set on a result read back from the shared cache. */
  checkedAt?: string;
}

/** One released version's section of the CHANGELOG, as written there (Markdown). */
export interface ReleaseNote { version: string; date: string | null; markdown: string }

/** What changed between the running build and the latest release, newest first. */
export interface ReleaseNotes {
  notes: ReleaseNote[];
  /** The code changes between the two releases on the forge, when the running build is a release too. */
  compareUrl: string | null;
}
