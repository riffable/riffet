import { cn } from '@/lib/utils';

/**
 * Semantic tree-node & file icon kinds (Zed / macOS / JetBrains New UI soft-filled style).
 * Avoids heavy 1.2px outer strokes in dense trees: folders and packages use layered soft fills,
 * and language marks use crisp, low-saturation theme variables (`--chart-1..8`, `--fg-*`) with
 * zero hardcoded hex values.
 */
export type FileIconKind = 'file' | 'folder' | 'module' | 'group' | 'source' | 'resources' | 'assets' | 'manifest' | 'package';

const TONE = {
  neutral: 'text-fg-3',
  muted: 'text-fg-4',
  blue: 'text-(--chart-1)',
  teal: 'text-(--chart-2)',
  orange: 'text-(--chart-3)',
  purple: 'text-(--chart-4)',
  pink: 'text-(--chart-5)',
  green: 'text-(--chart-6)',
  amber: 'text-(--chart-7)',
  slate: 'text-(--chart-8)',
} as const;

type Tone = keyof typeof TONE;

const base = (tone: Tone, className?: string) => cn('size-4 shrink-0', TONE[tone], className);

/**
 * Soft-filled layered folder (no heavy outline): back tab + translucent front pocket,
 * with distinct closed/open silhouettes and an optional clean module or package cue.
 */
function FolderSvg({ open = false, badge = false, pkg = false, subtle = false, tone = 'neutral', className }: {
  open?: boolean;
  badge?: boolean;
  pkg?: boolean;
  subtle?: boolean;
  tone?: Tone;
  className?: string | undefined;
}) {
  const backOpacity = subtle ? 0.24 : 0.34;
  const frontOpacity = subtle ? 0.38 : 0.56;
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base(tone, className)}>
      {open ? (
        <>
          <path
            d="M2 4.1C2 3.38 2.58 2.8 3.3 2.8h2.62c.38 0 .74.16.99.45l.59.68c.13.14.31.22.5.22h4.7c.72 0 1.3.58 1.3 1.3v1.15H2.85c-.42 0-.78.24-.85.62V4.1Z"
            fill="currentColor"
            fillOpacity={backOpacity}
          />
          <path
            d="M1.65 7.45c.14-.56.65-.95 1.23-.95h10.42c.75 0 1.3.7 1.12 1.43l-.92 3.72c-.15.62-.71 1.05-1.34 1.05H3.24c-.74 0-1.3-.68-1.14-1.4l-.45-3.85Z"
            fill="currentColor"
            fillOpacity={frontOpacity}
          />
        </>
      ) : (
        <>
          <path
            d="M2 4.15C2 3.4 2.6 2.8 3.35 2.8h2.58c.38 0 .74.16.99.45l.6.68c.12.14.3.22.49.22h4.64c.75 0 1.35.6 1.35 1.35v.7H2V4.15Z"
            fill="currentColor"
            fillOpacity={backOpacity}
          />
          <rect
            x="2"
            y="5.1"
            width="12"
            height="7.7"
            rx="1.5"
            fill="currentColor"
            fillOpacity={frontOpacity}
          />
        </>
      )}
      {badge && (
        <rect
          x="10.2"
          y="9.7"
          width="4.4"
          height="4.4"
          rx="1.2"
          fill="var(--chart-1)"
          stroke="var(--bg-sidebar)"
          strokeWidth="1.2"
        />
      )}
      {pkg && (
        <>
          <circle cx="11.6" cy="10.9" r="1.45" fill="var(--bg-sidebar)" />
          <circle cx="11.6" cy="10.9" r="0.85" fill="currentColor" fillOpacity="0.85" />
        </>
      )}
    </svg>
  );
}

/** Light, uncluttered package folder for Kotlin/Java dotted package chains (`com.example.app`). */
function PackageSvg({ open = false, className }: { open?: boolean; className?: string | undefined }) {
  return <FolderSvg open={open} pkg subtle tone="muted" className={className} />;
}

/** Manifest / XML section mark (soft-filled document with tiny angle cue). */
function ManifestSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('orange', className)}>
      <path d="M3.25 2.25h6.1l3.4 3.4v8.1c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1V3.25c0-.55.45-1 1-1Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M9.35 2.25v2.65c0 .41.34.75.75.75h2.65" fill="currentColor" fillOpacity="0.28" />
      <path d="M6.1 8.5L4.7 9.9l1.4 1.4M9.9 8.5l1.4 1.4-1.4 1.4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Kotlin soft geometric ribbon (`*.kt`, `*.kts`) without heavy outer border. */
function KotlinSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('purple', className)}>
      <path d="M3 3h10L8 8l5 5H3V3Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M3 3h5.2L3 8.2V3Z" fill="currentColor" fillOpacity="0.72" />
      <path d="M3 13l5-5 5 5H3Z" fill="currentColor" fillOpacity="0.48" />
    </svg>
  );
}

/** Java mark (`*.java`, `*.aidl`): soft-filled cup with subtle steam. */
function JavaSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('orange', className)}>
      <path d="M3.25 7h7.25v3.35a3.15 3.15 0 0 1-3.15 3.15H6.4a3.15 3.15 0 0 1-3.15-3.15V7Z" fill="currentColor" fillOpacity="0.58" />
      <path d="M10.5 8h1.15a1.4 1.4 0 0 1 0 2.8H10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.85" />
      <path d="M5.6 5.1c0-.7.7-.95.7-1.65M8.2 5.1c0-.7.7-.95.7-1.65" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeOpacity="0.75" />
    </svg>
  );
}

/** Gradle / build script emblem (`build.gradle`, `settings.gradle`, `*.gradle.kts`, `*.groovy`). */
function GradleSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('teal', className)}>
      <path d="M8 2.2l5 2.9v5.8L8 13.8l-5-2.9V5.1L8 2.2Z" fill="currentColor" fillOpacity="0.24" />
      <path d="M8 4.4l3.1 1.8v3.6L8 11.6 4.9 9.8V6.2L8 4.4Z" fill="currentColor" fillOpacity="0.62" />
    </svg>
  );
}

/** Clean borderless tinted badge for compact language monograms (`TS`, `JS`, `C`, `Go`, `Py`, `Rs`, `Sw`). */
function MonogramSvg({ label, tone, className }: { label: string; tone: Tone; className?: string | undefined }) {
  const two = label.length >= 2;
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base(tone, className)}>
      <rect x="2" y="2.25" width="12" height="11.5" rx="2.8" fill="currentColor" fillOpacity="0.16" />
      <text
        x="8"
        y="10.7"
        textAnchor="middle"
        fill="currentColor"
        fontSize={two ? '6.7' : '8'}
        fontWeight="700"
        fontFamily="var(--font-sans, ui-sans-serif, system-ui)"
        letterSpacing={two ? '-0.03em' : '0'}
      >
        {label}
      </text>
    </svg>
  );
}

/** Clean borderless angle brackets for XML / HTML / Vue / Svelte. */
function MarkupSvg({ tone, className }: { tone: Tone; className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base(tone, className)}>
      <path d="M5.6 5.2L2.8 8l2.8 2.8M10.4 5.2L13.2 8l-2.8 2.8M8.85 4.2l-1.7 7.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Borderless braces mark for JSON / JSONC / JSON5. */
function JsonSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('amber', className)}>
      <path
        d="M6.1 4c-.95 0-1.4.5-1.4 1.4v1.1c0 .7-.35 1.15-1 1.5.65.35 1 .8 1 1.5v1.1c0 .9.45 1.4 1.4 1.4M9.9 4c.95 0 1.4.5 1.4 1.4v1.1c0 .7.35 1.15 1 1.5-.65.35-1 .8-1 1.5v1.1c0 .9-.45 1.4-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Borderless config sliders (`*.properties`, `*.pro`, `*.toml`, `*.yml`, `.gitignore`). */
function ConfigSvg({ tone = 'slate', className }: { tone?: Tone; className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base(tone, className)}>
      <rect x="2" y="2.5" width="12" height="11" rx="2.6" fill="currentColor" fillOpacity="0.14" />
      <path d="M4.6 6.1h6.8M4.6 9.9h6.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.55" />
      <circle cx="6.5" cy="6.1" r="1.35" fill="currentColor" />
      <circle cx="9.6" cy="9.9" r="1.35" fill="currentColor" />
    </svg>
  );
}

/** Borderless soft shell / terminal mark. */
function ShellSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('green', className)}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="2.4" fill="currentColor" fillOpacity="0.16" />
      <path d="M4.75 6.25L7 8.15l-2.25 1.9M8.3 10.05h2.95" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Borderless stylesheet `#` mark (`*.css`, `*.scss`, `*.less`). */
function StyleSvg({ tone = 'blue', className }: { tone?: Tone; className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base(tone, className)}>
      <rect x="2" y="2.5" width="12" height="11" rx="2.6" fill="currentColor" fillOpacity="0.15" />
      <path d="M6.4 4.75l-1 6.5M10.4 4.75l-1 6.5M4.5 6.75h7M4.1 9.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Soft-filled document icon (plain text & Markdown). */
function DocSvg({ markdown = false, className }: { markdown?: boolean; className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base(markdown ? 'blue' : 'neutral', className)}>
      <path d="M3.25 2.25h6.1l3.4 3.4v8.1c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1V3.25c0-.55.45-1 1-1Z" fill="currentColor" fillOpacity="0.18" />
      <path d="M9.35 2.25v2.65c0 .41.34.75.75.75h2.65" fill="currentColor" fillOpacity="0.28" />
      {markdown ? (
        <path d="M4.7 11.4V8.2l1.65 1.85L8 8.2v3.2M10.4 8.15v3.1m0 0l-1.05-1.05m1.05 1.05l1.05-1.05" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M5 8.3h6M5 10.8h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.7" />
      )}
    </svg>
  );
}

/** Soft-filled image asset icon. */
function ImageSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('purple', className)}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2.2" fill="currentColor" fillOpacity="0.18" />
      <circle cx="5.75" cy="6.1" r="1.1" fill="currentColor" fillOpacity="0.8" />
      <path d="M3.1 11.7l3.05-3.05a.75.75 0 0 1 1.06 0L9.1 10.5l1.35-1.35a.75.75 0 0 1 1.06 0l1.65 1.65v1.2a1.25 1.25 0 0 1-1.25 1.25H4.35a1.25 1.25 0 0 1-1.25-1.25v-.3Z" fill="currentColor" fillOpacity="0.45" />
    </svg>
  );
}

/** Soft-filled SQL / database icon. */
function DatabaseSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('teal', className)}>
      <path d="M3.25 4.4v7.2c0 1 2.13 1.8 4.75 1.8s4.75-.8 4.75-1.8V4.4H3.25Z" fill="currentColor" fillOpacity="0.22" />
      <ellipse cx="8" cy="4.4" rx="4.75" ry="1.8" fill="currentColor" fillOpacity="0.52" />
      <path d="M3.25 8c0 1 2.13 1.8 4.75 1.8S12.75 9 12.75 8" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.55" />
    </svg>
  );
}

/** Soft-filled archive / binary package icon. */
function ArchiveSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('slate', className)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.4" fill="currentColor" fillOpacity="0.18" />
      <path d="M8 2.8v10.4" stroke="currentColor" strokeWidth="1.15" strokeDasharray="1.5 1.5" strokeOpacity="0.55" />
      <rect x="6.5" y="6.35" width="3" height="2.6" rx="0.7" fill="currentColor" fillOpacity="0.65" />
    </svg>
  );
}

/** Soft-filled generic code file. */
function GenericCodeSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('neutral', className)}>
      <path d="M3.25 2.25h6.1l3.4 3.4v8.1c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1V3.25c0-.55.45-1 1-1Z" fill="currentColor" fillOpacity="0.16" />
      <path d="M9.35 2.25v2.65c0 .41.34.75.75.75h2.65" fill="currentColor" fillOpacity="0.24" />
      <path d="M6.4 8.4L5 9.8l1.4 1.4M9.6 8.4L11 9.8l-1.4 1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.8" />
    </svg>
  );
}

/** Soft-filled plain file fallback. */
function PlainFileSvg({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={base('muted', className)}>
      <path d="M3.25 2.25h6.1l3.4 3.4v8.1c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1V3.25c0-.55.45-1 1-1Z" fill="currentColor" fillOpacity="0.22" />
      <path d="M9.35 2.25v2.65c0 .41.34.75.75.75h2.65" fill="currentColor" fillOpacity="0.34" />
    </svg>
  );
}

const GRADLE_FILE = /(?:^|\.)gradle(?:\.kts)?$|\.groovy$/i;
const KOTLIN_FILE = /\.kts?$/i;
const JAVA_FILE = /\.(?:java|aidl)$/i;
const TS_FILE = /\.(?:tsx?|mts|cts)$/i;
const JS_FILE = /\.(?:jsx?|mjs|cjs)$/i;
const XML_FILE = /\.(?:xml|plist|entitlements|pbxproj|xaml)$/i;
const HTML_FILE = /\.(?:html?|xhtml|vue|svelte|astro)$/i;
const JSON_FILE = /\.json[c5]?$/i;
const YAML_FILE = /\.ya?ml$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less)$/i;
const SHELL_FILE = /\.(?:sh|zsh|bash|fish|ps1|bat|cmd)$/i;
const SHELL_NAME = /^(?:dockerfile(?:\..*)?|makefile|gnumakefile|justfile|cmakelists\.txt|procfile|gradlew)$/i;
const CONFIG_FILE = /\.(?:toml|ini|cfg|conf|properties|pro|lock|env|po|pot|strings|xcstrings|xliff)$/i;
const CONFIG_NAME = /^\.(?:gitignore|gitattributes|gitmodules|editorconfig|npmrc|nvmrc|prettierrc.*|eslintrc.*|env(?:\..*)?)$/i;
const MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd|mdx|mdc)$/i;
const DOC_FILE = /\.(?:txt|rtf|rst|adoc|pdf|log|csv|tsv)$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|heic|icns|tiff?)$/i;
const ARCHIVE_FILE = /\.(?:zip|tar|gz|tgz|xz|bz2|7z|dmg|pkg|apk|ipa|aab|aar|whl|jar|wasm)$/i;
const DB_FILE = /\.(?:sql|db|sqlite|sqlite3)$/i;
const PY_FILE = /\.pyi?$/i;
const GO_FILE = /\.go$/i;
const RUST_FILE = /\.rs$/i;
const SWIFT_FILE = /\.swift$/i;
const C_FILE = /\.(?:c|h|cc|cpp|cxx|hpp|hh|m|mm)$/i;
const CODE_FALLBACK = /\.(?:rb|php|cs|dart|proto|graphql|gql|lua|r|scala|zig|ex|exs)$/i;

/**
 * Renders a refined 16×16 soft-filled IDE icon for any file, folder or module tree node.
 */
export function IdeFileIcon({
  name,
  directory = false,
  open = false,
  kind,
  className,
}: {
  name: string;
  directory?: boolean;
  open?: boolean;
  kind?: FileIconKind | undefined;
  className?: string | undefined;
}) {
  if (kind === 'module') return <FolderSvg open={open} badge tone="neutral" className={className} />;
  if (kind === 'source') return <FolderSvg open={open} tone="blue" className={className} />;
  if (kind === 'resources') return <FolderSvg open={open} tone="teal" className={className} />;
  if (kind === 'assets') return <FolderSvg open={open} tone="amber" className={className} />;
  if (kind === 'package') return <PackageSvg open={open} className={className} />;
  if (kind === 'manifest') return <ManifestSvg className={className} />;
  if (kind === 'folder' || kind === 'group' || directory) return <FolderSvg open={open} subtle={kind === 'group'} tone="neutral" className={className} />;

  const baseName = name.slice(name.lastIndexOf('/') + 1);
  if (GRADLE_FILE.test(baseName)) return <GradleSvg className={className} />;
  if (KOTLIN_FILE.test(baseName)) return <KotlinSvg className={className} />;
  if (JAVA_FILE.test(baseName)) return <JavaSvg className={className} />;
  if (TS_FILE.test(baseName)) return <MonogramSvg label="TS" tone="blue" className={className} />;
  if (JS_FILE.test(baseName)) return <MonogramSvg label="JS" tone="amber" className={className} />;
  if (XML_FILE.test(baseName)) return <MarkupSvg tone="orange" className={className} />;
  if (HTML_FILE.test(baseName)) return <MarkupSvg tone="pink" className={className} />;
  if (JSON_FILE.test(baseName)) return <JsonSvg className={className} />;
  if (YAML_FILE.test(baseName)) return <ConfigSvg tone="pink" className={className} />;
  if (STYLE_FILE.test(baseName)) return <StyleSvg tone={/\.s?css$/i.test(baseName) && !/\.css$/i.test(baseName) ? 'purple' : 'blue'} className={className} />;
  if (SHELL_NAME.test(baseName) || SHELL_FILE.test(baseName)) return <ShellSvg className={className} />;
  if (PY_FILE.test(baseName)) return <MonogramSvg label="Py" tone="blue" className={className} />;
  if (GO_FILE.test(baseName)) return <MonogramSvg label="Go" tone="teal" className={className} />;
  if (RUST_FILE.test(baseName)) return <MonogramSvg label="Rs" tone="orange" className={className} />;
  if (SWIFT_FILE.test(baseName)) return <MonogramSvg label="Sw" tone="orange" className={className} />;
  if (C_FILE.test(baseName)) return <MonogramSvg label={/(?:pp|cc|xx|mm)$/i.test(baseName) ? 'C+' : 'C'} tone="blue" className={className} />;
  if (MARKDOWN_FILE.test(baseName)) return <DocSvg markdown className={className} />;
  if (IMAGE_FILE.test(baseName)) return <ImageSvg className={className} />;
  if (DB_FILE.test(baseName)) return <DatabaseSvg className={className} />;
  if (CONFIG_NAME.test(baseName) || CONFIG_FILE.test(baseName)) return <ConfigSvg tone="slate" className={className} />;
  if (ARCHIVE_FILE.test(baseName)) return <ArchiveSvg className={className} />;
  if (DOC_FILE.test(baseName)) return <DocSvg className={className} />;
  if (CODE_FALLBACK.test(baseName)) return <GenericCodeSvg className={className} />;
  return <PlainFileSvg className={className} />;
}
