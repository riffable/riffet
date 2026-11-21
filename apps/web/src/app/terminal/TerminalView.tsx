import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconCornerDownLeft, IconDownload, IconEllipsis, IconHand, IconOctagonX, IconRefreshCw, IconUnlock, IconX } from '@/components/icons';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_ACK_CHARS, TERMINAL_KEPT_ROWS, type TerminalInfo, type TerminalServerMessage } from '@contracts';
import { Button } from '@/components/ui/button';
import { Spinner, StatusDot, StatusPill } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, terminalSocketUrl } from '@/lib/api';
import { boundedCache } from '@/lib/bounded-cache';
import { confirmDialog } from '@/lib/dialogs';
import { pageTerminalAppearance, terminalFont, terminalTheme } from '@/lib/terminal-theme';
import { customThemeAnsi } from '@/lib/theme-library';
import { useTheme } from '@/lib/theme';
import { useDisplaySettings } from '@/lib/display-settings';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { cn, downloadJson, errorMessage, reconnectDelay } from '@/lib/utils';
import { clipboardFiles, readUploadData, uploadName } from '../session/image-upload';
import { attachmentMimeType, planIntake } from '../session/composerAttachmentIntake';
import { attachSmoothScroll } from './smooth-scroll';
import { readTerminalGrid } from './grid-diagnostics';

type ClientMessage =
  | { type: 'claim'; clientId: string; takeover?: boolean }
  | { type: 'input'; clientId: string; epoch: number; data: string }
  | { type: 'paste'; clientId: string; epoch: number; data: string }
  | { type: 'resize'; clientId: string; epoch: number; cols: number; rows: number }
  | { type: 'ack'; chars: number }
  | { type: 'release'; clientId: string; epoch: number };

type Connection = 'connecting' | 'connected' | 'reconnecting' | 'closed';

const createClientId = () => `web-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
/** Above the server's 2M allowance, so a client whose parser lags is reseeded by the server first. */
const MAX_PENDING_TERMINAL_CHARS = 4 * 1024 * 1024;
const KEY_REPEAT_DELAY_MS = 400;
const KEY_REPEAT_MS = 80;
/** Longer than this in the background and a phone has usually dropped the socket underneath us. */
const SOCKET_AWAY_MS = 20_000;

/** How many conversations' last requested colours are remembered. */
const REQUESTED_APPEARANCE_LIMIT = 6;
/** Set once a WebGL context is lost or cannot be made: later terminals in this page use the DOM renderer. */
let webglUnavailable = false;
/** WebGL only on desktop Chromium; WebKit (Safari, WKWebView) and touch devices keep the DOM renderer. */
const useWebgl = () => !webglUnavailable
  && /Chrome\/|Chromium\//.test(navigator.userAgent) && !/CriOS|FxiOS|Android|Mobile/.test(navigator.userAgent)
  && !window.matchMedia('(pointer: coarse)').matches;

/** The colours this page last asked each conversation's pane for. */
const requestedAppearances = boundedCache<string, { key: string } | null>({ limit: REQUESTED_APPEARANCE_LIMIT });

interface Props {
  terminal: TerminalInfo;
  active: boolean;
  onChanged: (terminal: TerminalInfo) => void;
  onClose?: (terminal: TerminalInfo) => void;
  onError: (message: string) => void;
  toolbar?: boolean;
  showTitle?: boolean;
  /** Leave the touch keyboard closed until the user interacts with the terminal surface. */
  autoFocus?: boolean;
  className?: string;
  /** Extra toolbar buttons, rendered before the built-in ones. */
  actions?: ReactNode;
  /** Rendered at the toolbar's start, before the connection state. */
  leading?: ReactNode;
}

/**
 * The lease line in the toolbar. Our own states keep a code and are worded where they are shown, so
 * a language switch reaches a line already on screen; a server error keeps its own text.
 */
type LeaseMessage = 'checking' | 'control' | 'other-device' | 'readonly' | 'takeover' | 'requesting' | { text: string };

export function TerminalView({ terminal, active, onChanged, onClose, onError, toolbar = true, showTitle = true, autoFocus = true, className, actions, leading }: Props) {  const { t } = useLingui();
  // Key names are UI labels for the on-screen keyboard; the key data stays exactly as xterm expects.
  const space = t`空格`;
  const up = t`上`;
  const down = t`下`;
  const left = t`左`;
  const right = t`右`;
  const enter = t`回车`;
  const mobileKeys: Array<{ label: ReactNode; name: string; data: string; repeat?: boolean }> = [
    { label: 'Esc', name: 'Esc', data: '\x1b' }, { label: 'Tab', name: 'Tab', data: '\t' }, { label: space, name: space, data: ' ' },
    { label: <IconArrowUp className="size-3.5" />, name: up, data: '\x1b[A', repeat: true }, { label: <IconArrowDown className="size-3.5" />, name: down, data: '\x1b[B', repeat: true },
    { label: <IconArrowLeft className="size-3.5" />, name: left, data: '\x1b[D', repeat: true }, { label: <IconArrowRight className="size-3.5" />, name: right, data: '\x1b[C', repeat: true },
    { label: <IconCornerDownLeft className="size-3.5" />, name: enter, data: '\r' }, { label: '^C', name: 'Ctrl+C', data: '\x03' },
  ];
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingWriteCharsRef = useRef(0);
  const clientId = useMemo(createClientId, [terminal.id]);
  const { terminalFontSize, terminalPaddingHorizontal, terminalPaddingVertical } = useDisplaySettings();
  /**
   * The size the terminal was built with. Read through a ref so a later change does not re-run the
   * construction effect — that would dispose the socket and the pane's scrollback.
   */
  const fontSizeRef = useRef(terminalFontSize);
  fontSizeRef.current = terminalFontSize;
  const epochRef = useRef(terminal.epoch);
  const terminalStateRef = useRef(terminal.state);
  terminalStateRef.current = terminal.state;
  const controlRef = useRef(false);
  const lastResizeRef = useRef<{ cols: number; rows: number } | undefined>(undefined);
  const fitCallbackRef = useRef<() => void>(() => undefined);
  const resizeRetryRef = useRef<number | undefined>(undefined);
  const onChangedRef = useRef(onChanged);
  const onErrorRef = useRef(onError);
  const retryRef = useRef<number | undefined>(undefined);
  const retryCount = useRef(0);
  const remoteSizeRef = useRef({ cols: terminal.cols, rows: terminal.rows });
  const [uploading, setUploading] = useState(false);
  const intakeRef = useRef(false);
  const viewGenerationRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [atBottom, setAtBottom] = useState(true);
  /** Typed input and pastes waiting for control, in the order they were made. */
  const pendingInputRef = useRef<Array<{ paste: boolean; data: string }>>([]);
  const claimingRef = useRef(false);
  const inputRevisionRef = useRef(0);
  const leaseWaiterRef = useRef<{ resolve: (epoch: number) => void; reject: (error: Error) => void; timer: number } | undefined>(undefined);
  const repeatTimers = useRef<{ delay?: number; interval?: number }>({});
  const [connection, setConnection] = useState<Connection>('connecting');
  const [leaseMessage, setLeaseMessage] = useState<LeaseMessage>('checking');
  const [hasControl, setHasControl] = useState(false);
  const { themeId, resolved, revision, pluginAnsi } = useTheme();
  // Compare requests against the pane's own stream: the list copy can lag behind a colour change.
  const [streamAppearance, setStreamAppearance] = useState<{ value: TerminalInfo['appearance'] }>();
  const appearance = streamAppearance ? streamAppearance.value : terminal.appearance;
  // Paint with this page's current theme immediately. A busy CLI can keep its launch appearance
  // until it is safe to relaunch; that must not pin the viewer to the previous light/dark mode.
  const terminalDark = resolved === 'dark';
  const palette = useMemo(() => terminalTheme(themeId, terminalDark, pluginAnsi ? pluginAnsi[terminalDark ? 'dark' : 'light'] : customThemeAnsi(themeId, terminalDark)), [themeId, terminalDark, revision, pluginAnsi]);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  // The pane follows the theme of whoever is looking at it. The server recolours it in place or, for
  // a CLI that read its colours once at startup, relaunches it when idle. Remembered per conversation:
  // a relaunch brings a new terminal id, and another device's later choice must not start a ping-pong.
  useEffect(() => {
    if (!active || terminal.state === 'exited') return;
    const wanted = pageTerminalAppearance();
    const target = terminal.sessionId ?? terminal.id;
    const key = `${wanted.foreground};${wanted.background}`;
    const known = requestedAppearances.get(target)?.key === key;
    if (known) return;
    const request = { key };
    requestedAppearances.set(target, request);
    if (appearance?.foreground === wanted.foreground && appearance.background === wanted.background) return;
    void api.setTerminalAppearance(terminal.id, wanted).then((info) => onChangedRef.current(info)).catch(() => {
      // Reopening or reconnecting must retry a failed request. An older rejection must not erase
      // a newer request, even if the user has already switched away and back to the same colours.
      if (requestedAppearances.get(target) === request) requestedAppearances.set(target, null);
    });
  }, [active, connection, terminal.id, terminal.state, appearance?.foreground, appearance?.background, themeId, resolved, revision]);

  useEffect(() => { epochRef.current = terminal.epoch; }, [terminal.epoch]);
  useEffect(() => { onChangedRef.current = onChanged; onErrorRef.current = onError; }, [onChanged, onError]);
  useEffect(() => { controlRef.current = hasControl; }, [hasControl]);
  // Updating xterm's theme repaints in place, preserving the socket and scrollback.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = palette;
  }, [palette]);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /** Typing, a key tap or a paste from a device without control takes the terminal over, then delivers it. */
  const deliver = useCallback((data: string, paste: boolean) => {
    inputRevisionRef.current += 1;
    if (controlRef.current) { send({ type: paste ? 'paste' : 'input', clientId, epoch: epochRef.current, data }); return; }
    const pending = pendingInputRef.current;
    const last = pending[pending.length - 1];
    if (last && !last.paste && !paste) last.data += data;
    else pending.push({ paste, data });
    if (claimingRef.current) return;
    claimingRef.current = true;
    send({ type: 'claim', clientId, takeover: true });
  }, [clientId, send]);
  const sendInput = useCallback((data: string) => deliver(data, false), [deliver]);
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;

  const pasteAttachmentsRef = useRef<(files: File[], text: string) => Promise<void>>(async () => undefined);
  pasteAttachmentsRef.current = async (files, text) => {
    if (intakeRef.current) { onErrorRef.current(t`附件正在上传`); return; }
    const plan = planIntake(files, 0, new Set());
    if (plan.kind === 'rejected') { onErrorRef.current(plan.reason); return; }
    if (plan.kind === 'empty') return;
    const generation = viewGenerationRef.current;
    const inputRevision = inputRevisionRef.current;
    const socket = socketRef.current;
    const current = () => generation === viewGenerationRef.current && inputRevision === inputRevisionRef.current && activeRef.current && socket === socketRef.current && socket?.readyState === WebSocket.OPEN;
    if (!current()) { onErrorRef.current(t`终端正在重连，请稍后再试。`); return; }
    intakeRef.current = true;
    setUploading(true);
    let pasteSent = false;
    try {
      // Claim at the user's gesture, before uploading. An expired lease is never reacquired later.
      let epoch = epochRef.current;
      if (!controlRef.current) {
        epoch = await new Promise<number>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            leaseWaiterRef.current = undefined;
            reject(new Error(t`终端正在重连，请稍后再试。`));
          }, 10_000);
          leaseWaiterRef.current = { resolve, reject, timer };
          send({ type: 'claim', clientId, takeover: true });
        });
        if (!current()) throw new Error(t`终端控制权或输入位置已变更，请重新粘贴。`);
      }
      const attachmentIds: string[] = [];
      for (const entry of plan.entries) {
        if (!current() || epochRef.current > epoch) throw new Error(t`终端控制权或输入位置已变更，请重新粘贴。`);
        const original = files[entry.index]!;
        const mimeType = attachmentMimeType(original);
        const file = mimeType === original.type ? original : new File([original], original.name, { type: mimeType, lastModified: original.lastModified });
        const data = await readUploadData(file);
        const attachment = await api.upload(terminal.projectId, { name: uploadName(file, data.mimeType), ...data });
        attachmentIds.push(attachment.id);
      }
      if (!current() || epochRef.current > epoch) throw new Error(t`终端控制权或输入位置已变更，请重新粘贴。`);
      pasteSent = true;
      const result = await api.pasteTerminalAttachments(terminal.id, { clientId, epoch, requestId: crypto.randomUUID(), attachmentIds, ...(text ? { text } : {}) });
      if (result.status === 'unknown' && current()) onErrorRef.current(t`粘贴结果待确认，请检查终端。`);
    } catch (error) {
      if (generation === viewGenerationRef.current) onErrorRef.current(pasteSent && !(error instanceof HttpError) ? t`粘贴结果待确认，请检查终端。` : errorMessage(error, t`无法粘贴附件`));
    } finally {
      if (generation === viewGenerationRef.current) { intakeRef.current = false; setUploading(false); }
    }
  };

  // Leaving the target invalidates an upload even if the user returns before it finishes.
  useEffect(() => { if (!active) inputRevisionRef.current += 1; }, [active]);

  useLayoutEffect(() => {
    intakeRef.current = false;
    setUploading(false);
  }, [terminal.id]);

  const fit = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon || !active || !hostRef.current?.clientWidth) return;
    try {
      if (controlRef.current) fitAddon.fit();
      else {
        const remote = remoteSizeRef.current;
        if (term.cols !== remote.cols || term.rows !== remote.rows) term.resize(remote.cols, remote.rows);
      }
      const { cols, rows } = term;
      const lastSize = lastResizeRef.current;
      if (cols > 0 && rows > 0 && controlRef.current && (!lastSize || lastSize.cols !== cols || lastSize.rows !== rows)) {
        // A pane being dragged would resize the PTY every frame, and a full-screen CLI redraws each
        // time: the size it settles at goes out once the drag has ended.
        if (document.documentElement.dataset.resizing) {
          window.clearTimeout(resizeRetryRef.current);
          resizeRetryRef.current = window.setTimeout(() => fitCallbackRef.current(), 150);
          return;
        }
        lastResizeRef.current = { cols, rows };
        send({ type: 'resize', clientId, epoch: epochRef.current, cols, rows });
      }
    } catch (error) {
      onErrorRef.current(errorMessage(error, t`无法调整终端尺寸`));
    }
  }, [active, clientId, send]);
  fitCallbackRef.current = fit;
  useEffect(() => () => window.clearTimeout(resizeRetryRef.current), []);
  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      cols: remoteSizeRef.current.cols,
      rows: remoteSizeRef.current.rows,
      minimumContrastRatio: 4.5,
      ...terminalFont,
      fontSize: fontSizeRef.current,
      // The server's snapshot carries the pane's history, so the emulator owns scrollback.
      scrollback: window.matchMedia(MOBILE_LAYOUT_QUERY).matches ? TERMINAL_KEPT_ROWS.phone : TERMINAL_KEPT_ROWS.web,
      convertEol: false,
      allowProposedApi: false,
      theme: paletteRef.current,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;
    if (useWebgl()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webglUnavailable = true;
          webgl.dispose();
          requestAnimationFrame(() => fitCallbackRef.current());
        });
        term.loadAddon(webgl);
      } catch {
        webglUnavailable = true;
      }
    }
    const syncBottom = () => setAtBottom(term.buffer.active.viewportY >= term.buffer.active.baseY);
    const scrollSubscription = term.onScroll(syncBottom);
    // xterm 6's public onData merges parser replies with user input. Its pinned CoreService
    // emits onUserInput synchronously immediately before user onData, including delayed IME
    // commits. Keep this adapter narrow: DOM event timing cannot classify composition reliably.
    const inputSource = (term as unknown as { _core: { coreService: { onUserInput: (listener: () => void) => IDisposable } } })._core.coreService;
    let userInput = false;
    const sourceSubscription = inputSource.onUserInput(() => { userInput = true; });
    const inputSubscription = term.onData((data) => {
      const fromUser = userInput;
      userInput = false;
      if (fromUser) sendInputRef.current(data);
      else if (controlRef.current) send({ type: 'input', clientId, epoch: epochRef.current, data });
    });
    const onPaste = (event: ClipboardEvent) => {
      const files = clipboardFiles(event.clipboardData);
      const text = event.clipboardData?.getData('text/plain') ?? '';
      event.preventDefault();
      event.stopPropagation();
      if (files.length) void pasteAttachmentsRef.current(files, text);
      else if (text) deliverRef.current(text, true);
    };
    hostRef.current.addEventListener('paste', onPaste, true);
    const smoothScroll = attachSmoothScroll(term, hostRef.current);
    const host = hostRef.current;
    const resizeObserver = new ResizeObserver(() => fitCallbackRef.current());
    resizeObserver.observe(host);
    requestAnimationFrame(() => fitCallbackRef.current());
    return () => {
      inputSubscription.dispose();
      sourceSubscription.dispose();
      scrollSubscription.dispose();
      host.removeEventListener('paste', onPaste, true);
      smoothScroll.dispose();
      resizeObserver.disconnect();
      term.dispose();
      pendingWriteCharsRef.current = 0;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [clientId, send]);

  /**
   * A size change is applied in place and re-measured. Rebuilding the terminal would drop the
   * socket, the claim and the scrollback just to change a font size.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalFontSize;
    fitCallbackRef.current();
  }, [terminalFontSize]);

  useEffect(() => {
    viewGenerationRef.current += 1;
    let closed = false;
    let connectedOnce = false;
    let exited = terminalStateRef.current === 'exited';
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      // A fresh connection starts with a full snapshot, so nothing is left half-parsed.
      if (pendingWriteCharsRef.current > 0) {
        // Let writes from the previous connection finish before its replacement snapshot
        // resets the terminal. Otherwise queued old bytes could be applied after that reset.
        retryRef.current = window.setTimeout(connect, 100);
        return;
      }
      setConnection(retryCount.current ? 'reconnecting' : 'connecting');
      let ready = false;
      let streamId: string | undefined;
      const retiredStreams = new Set<string>();
      let sequence = -1;
      socket = new WebSocket(terminalSocketUrl(terminal.id));
      socketRef.current = socket;
      let overloaded = false;
      // Characters written since the last ack; the server reseeds a listener that falls far behind.
      let unacked = 0;
      // A seed can be megabytes of scrollback; only output queued behind it counts as falling behind.
      let seedPending = 0;
      const writeOutput = (data: string, snapshot = false) => {
        const term = termRef.current;
        if (!term || overloaded) return;
        if (!snapshot && pendingWriteCharsRef.current - seedPending + data.length > MAX_PENDING_TERMINAL_CHARS) {
          // xterm parses writes asynchronously. Drop this connection once its parser falls
          // behind; the next subscription starts with a pane snapshot, while other viewers
          // continue to receive the live stream.
          overloaded = true;
          socket?.close(1013, 'Terminal parser is behind');
          return;
        }
        pendingWriteCharsRef.current += data.length;
        if (snapshot) seedPending += data.length;
        term.write(data, () => {
          pendingWriteCharsRef.current = Math.max(0, pendingWriteCharsRef.current - data.length);
          if (snapshot) seedPending -= data.length;
          if (snapshot) fitCallbackRef.current();
          unacked += data.length;
          if (unacked >= TERMINAL_ACK_CHARS && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ack', chars: unacked } satisfies ClientMessage));
            unacked = 0;
          }
        });
      };
      socket.onopen = () => {
        retryCount.current = 0;
        setConnection('connected');
        // Opening a terminal takes it over from a device left open elsewhere; a reconnect does not steal it back.
        socket?.send(JSON.stringify({ type: 'claim', clientId, ...(connectedOnce ? {} : { takeover: true }) } satisfies ClientMessage));
        connectedOnce = true;
        requestAnimationFrame(() => fitCallbackRef.current());
      };
      socket.onmessage = (event) => {
        let message: TerminalServerMessage;
        try { message = JSON.parse(String(event.data)) as TerminalServerMessage; }
        catch { return; }
        if (message.type === 'snapshot') {
          if (retiredStreams.has(message.streamId) || (streamId === message.streamId && message.sequence < sequence)) return;
          if (streamId && streamId !== message.streamId) retiredStreams.add(streamId);
          streamId = message.streamId;
          sequence = message.sequence;
          ready = true;
          remoteSizeRef.current = { cols: message.cols, rows: message.rows };
          const term = termRef.current;
          if (term) {
            // xterm can parse the first write after user input synchronously. Geometry must
            // therefore be established before enqueueing the replacement, not after write().
            if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
            // The seed starts with a reset; it runs in the parser queue after preceding writes.
            writeOutput(message.data.startsWith('\x1bc') ? message.data : `\x1bc${message.data}`, true);
          }
        } else if (message.type === 'output') {
          if (!ready && !message.streamId) { ready = true; termRef.current?.write('\x1bc'); }
          if (!ready || (message.streamId && message.streamId !== streamId) || message.sequence <= sequence) return;
          sequence = message.sequence;
          writeOutput(message.data);
        }
        else if (message.type === 'state') {
          const next = message.terminal;
          epochRef.current = next.epoch;
          setStreamAppearance(current => current && current.value?.foreground === next.appearance?.foreground && current.value?.background === next.appearance?.background
            ? current : { value: next.appearance });
          remoteSizeRef.current = { cols: next.cols, rows: next.rows };
          onChangedRef.current(next);
          const ownsControl = next.ownerId === clientId;
          if (controlRef.current !== ownsControl) lastResizeRef.current = undefined;
          controlRef.current = ownsControl;
          if (ownsControl) {
            const waiter = leaseWaiterRef.current;
            if (waiter) { window.clearTimeout(waiter.timer); leaseWaiterRef.current = undefined; waiter.resolve(next.epoch); }
            claimingRef.current = false;
            const pending = pendingInputRef.current;
            pendingInputRef.current = [];
            for (const item of pending) send({ type: item.paste ? 'paste' : 'input', clientId, epoch: next.epoch, data: item.data });
          }
          setHasControl(ownsControl);
          setLeaseMessage(ownsControl ? 'control' : next.ownerId ? 'other-device' : 'readonly');
          requestAnimationFrame(() => fitCallbackRef.current());
        } else if (message.type === 'error') {
          const waiter = leaseWaiterRef.current;
          if (waiter) { window.clearTimeout(waiter.timer); leaseWaiterRef.current = undefined; waiter.reject(new Error(message.message)); }
          claimingRef.current = false;
          pendingInputRef.current = [];
          setLeaseMessage({ text: message.message });
          if (message.code !== 'LEASE_REQUIRED') onErrorRef.current(message.message);
        } else if (message.type === 'exit') {
          exited = true;
          setConnection('closed');
          const label = message.exitCode === undefined ? i18n._(msg`[进程已退出]`) : i18n._(msg`[进程已退出，退出码 ${message.exitCode}]`);
          termRef.current?.write(`\r\n\x1b[90m${label}\x1b[0m\r\n`);
        }
      };
      socket.onerror = () => setConnection('reconnecting');
      socket.onclose = () => {
        if (closed) return;
        const waiter = leaseWaiterRef.current;
        if (waiter) { window.clearTimeout(waiter.timer); leaseWaiterRef.current = undefined; waiter.reject(new Error(i18n._(msg`终端正在重连，请稍后再试。`))); }
        if (exited || terminalStateRef.current === 'exited') { setConnection('closed'); return; }
        setConnection('reconnecting');
        controlRef.current = false;
        claimingRef.current = false;
        pendingInputRef.current = [];
        lastResizeRef.current = undefined;
        setHasControl(false);
        retryCount.current += 1;
        retryRef.current = window.setTimeout(connect, reconnectDelay(retryCount.current));
      };
    };
    // A phone freezes a background page with its socket. On return, retry now instead of waiting
    // out a backoff that grew meanwhile, and replace a socket that sat frozen long enough to be dead.
    let hiddenAt: number | undefined;
    const revive = () => {
      if (closed || exited || terminalStateRef.current === 'exited' || document.visibilityState !== 'visible') return;
      const away = hiddenAt !== undefined && Date.now() - hiddenAt > SOCKET_AWAY_MS;
      hiddenAt = undefined;
      const current = socketRef.current;
      if (current?.readyState === WebSocket.CONNECTING || (current?.readyState === WebSocket.OPEN && !away)) return;
      if (current) {
        // A dead socket can take minutes to report its close; drop it without waiting.
        current.onopen = current.onmessage = current.onerror = current.onclose = null;
        current.close();
        controlRef.current = false;
        claimingRef.current = false;
        pendingInputRef.current = [];
        lastResizeRef.current = undefined;
        setHasControl(false);
      }
      if (retryRef.current !== undefined) window.clearTimeout(retryRef.current);
      retryCount.current = 1;
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt ??= Date.now();
      else revive();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', revive);
    window.addEventListener('online', revive);
    connect();
    return () => {
      closed = true;
      viewGenerationRef.current += 1;
      const waiter = leaseWaiterRef.current;
      if (waiter) { window.clearTimeout(waiter.timer); leaseWaiterRef.current = undefined; waiter.reject(new Error(i18n._(msg`终端已关闭`))); }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', revive);
      window.removeEventListener('online', revive);
      if (retryRef.current !== undefined) window.clearTimeout(retryRef.current);
      const current = socketRef.current;
      if (current?.readyState === WebSocket.OPEN && controlRef.current) current.send(JSON.stringify({ type: 'release', clientId, epoch: epochRef.current } satisfies ClientMessage));
      current?.close();
      socketRef.current = null;
    };
  }, [clientId, terminal.id]);

  useEffect(() => { if (active) requestAnimationFrame(() => { fit(); if (autoFocus) termRef.current?.focus(); }); }, [active, autoFocus, fit]);

  const claim = (takeover: boolean) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) { onError(t`终端正在重连，请稍后再试。`); return; }
    send({ type: 'claim', clientId, ...(takeover ? { takeover: true } : {}) });
    setLeaseMessage(takeover ? 'takeover' : 'requesting');
  };
  const release = () => {
    send({ type: 'release', clientId, epoch: epochRef.current });
    controlRef.current = false;
    lastResizeRef.current = undefined;
    setHasControl(false);
    setLeaseMessage('readonly');
  };
  const interrupt = async () => {
    const ok = await confirmDialog({ title: t`中断当前进程？`, description: t`会向终端发送 Ctrl+C。Agent CLI 会停止当前任务，并可能接着发送它自己排队的消息。`, confirmLabel: t({ message: '中断', context: 'terminal-interrupt-action' }), destructive: true });
    if (ok) await api.interruptTerminal(terminal.id).catch((error) => onError(errorMessage(error, t`无法中断进程`)));
  };
  const stopRepeat = () => {
    window.clearTimeout(repeatTimers.current.delay);
    window.clearInterval(repeatTimers.current.interval);
    repeatTimers.current = {};
  };
  useEffect(() => stopRepeat, []);
  // Keys act on pointer down without taking focus, so a tap neither opens nor closes the phone keyboard.
  const pressKey = (data: string, repeat?: boolean) => {
    stopRepeat();
    sendInput(data);
    if (repeat) repeatTimers.current.delay = window.setTimeout(() => {
      repeatTimers.current.interval = window.setInterval(() => sendInput(data), KEY_REPEAT_MS);
    }, KEY_REPEAT_DELAY_MS);
  };
  const backToLive = () => {
    termRef.current?.scrollToBottom();
    setAtBottom(true);
  };
  const exportGridDiagnostics = async () => {
    const term = termRef.current;
    if (!term) return;
    // Sample before the round trip. fit() would resize the very grid we want to inspect.
    const sampledAt = new Date().toISOString();
    const browser = {
      ...readTerminalGrid(term),
      containerCapacity: fitRef.current?.proposeDimensions() ?? null,
      containerHeightPx: hostRef.current?.clientHeight ?? null,
      rowsScrolledBack: term.buffer.active.baseY - term.buffer.active.viewportY,
      hasControl: controlRef.current,
      lastRequestedSize: lastResizeRef.current ?? null,
      lastReportedSize: remoteSizeRef.current,
    };
    const tmux = await api.terminalGridDiagnostics(terminal.id).catch((error: unknown) => ({
      unavailable: true, httpStatus: error instanceof HttpError ? error.status : null,
    }));
    downloadJson('riffet-terminal-grid.json', { sampledAt, receivedAt: new Date().toISOString(), browser, tmux });
  };

  const tone = connection === 'connected' ? 'success' : connection === 'closed' ? 'idle' : 'warning';
  const connectionLabel = { connecting: t`连接中`, connected: t`已连接`, reconnecting: t`重连中`, closed: t`已退出` }[connection];

  return (
    <section
      data-terminal aria-busy={uploading}
      onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}
      onDrop={(event) => {
        const files = clipboardFiles(event.dataTransfer);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void pasteAttachmentsRef.current(files, '');
      }}
      className={cn('flex min-h-0 flex-1 flex-col bg-bg', className)} aria-label={t`${terminal.title} 终端`}
    >
      {toolbar && (
        <div className={cn('flex shrink-0 items-center gap-2 edge-b px-3 max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:px-2 max-md:py-1', leading ? 'h-10' : 'h-9')}>
          {leading}
          <Tip label={connectionLabel}><span className="grid size-4 place-items-center"><StatusDot tone={tone} pulse={connection === 'reconnecting'} /></span></Tip>
          {uploading && <Spinner className="size-3.5" />}
          {showTitle && <span className="min-w-0 truncate text-sm font-medium text-fg">{terminal.title}</span>}
          {/* Nobody holds the terminal, so control is one safe click away; taking it from another
              device stays in the menu. */}
          {(leaseMessage === 'readonly' || leaseMessage === 'requesting') && !terminal.ownerId && terminal.state !== 'exited'
            // The request keeps the pill, spinning, so the toolbar does not jump while it is answered.
            ? <StatusPill label={leaseMessage === 'requesting' ? t`正在申请` : t`只读`} actionLabel={t`获取控制权`} busy={leaseMessage === 'requesting'} disabled={connection !== 'connected'} onAction={() => claim(false)} />
            : <span className="min-w-0 truncate text-xs text-fg-3">{typeof leaseMessage === 'string'
              ? leaseMessage === 'checking' ? t`正在检查控制权` : leaseMessage === 'control' ? t`可输入` : leaseMessage === 'other-device' ? t`其他设备正在控制` : leaseMessage === 'takeover' ? t`正在接管` : leaseMessage === 'requesting' ? t`正在申请` : t`只读`
              : leaseMessage.text}</span>}
          <div className="ml-auto flex max-w-full flex-wrap items-center gap-0.5 md:shrink-0 md:flex-nowrap">
            {actions}
            {/* The control actions live in one menu; `actions` (e.g. switching back to the
                conversation) stays outside it as the one quick button. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-xs" variant="quiet" aria-label={t`更多操作`} className="no-hover:size-11"><IconEllipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hasControl
                  ? <DropdownMenuItem onSelect={release}><IconUnlock />{t`释放控制权`}</DropdownMenuItem>
                  : <DropdownMenuItem onSelect={() => claim(Boolean(terminal.ownerId))}><IconHand />{terminal.ownerId ? t`接管` : t`获取控制权`}</DropdownMenuItem>}
                <DropdownMenuItem disabled={terminal.state === 'exited'} onSelect={() => { retryCount.current = 0; socketRef.current?.close(); }}><IconRefreshCw />{t`重新连接`}</DropdownMenuItem>
                {import.meta.env.DEV && <DropdownMenuItem onSelect={() => void exportGridDiagnostics()}><IconDownload />{t`导出终端布局诊断`}</DropdownMenuItem>}
                {terminal.state === 'running' && <DropdownMenuItem onSelect={() => void interrupt()}><IconOctagonX />{t`中断进程 (SIGINT)`}</DropdownMenuItem>}
                {onClose && <DropdownMenuItem onSelect={() => onClose(terminal)}><IconX />{t`关闭终端`}</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
      <div className="relative min-h-0 flex-1" style={{ backgroundColor: palette.background, color: palette.foreground, padding: `${terminalPaddingVertical}px ${terminalPaddingHorizontal}px` }}>
        {/* xterm scrolls its own history. The wrapper only moves sideways (or both ways for a remote grid
            larger than this view); a one-finger vertical swipe is handled by the touch listeners above. */}
        <div className="h-full touch-pan-x overflow-auto overscroll-contain">
          <div className={cn("h-full no-hover:[&_.xterm]:pointer-events-none", !hasControl && "min-w-max")} onClick={() => termRef.current?.focus()}>
            <div ref={hostRef} className="h-full w-full" />
          </div>
        </div>
        {!atBottom && (
          <button type="button" onClick={backToLive} className="absolute bottom-3 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-elevated px-3.5 text-xs text-fg-2 shadow-md">
            <IconArrowDown className="size-3.5" /><Trans>回到实时</Trans>
          </button>
        )}
      </div>
      {active && (
        <div className="flex h-12 shrink-0 touch-none items-center gap-1 edge-t px-1.5 md:hidden">
          {mobileKeys.map((key) => (
            <button
              key={key.name}
              type="button"
              aria-label={key.name}
              onPointerDown={(event) => { event.preventDefault(); pressKey(key.data, key.repeat); }}
              onPointerUp={stopRepeat}
              onPointerLeave={stopRepeat}
              onPointerCancel={stopRepeat}
              onContextMenu={(event) => event.preventDefault()}
              onClick={(event) => { if (event.detail === 0) sendInput(key.data); }}
              className="grid h-10 min-w-0 flex-1 select-none place-items-center rounded-md border border-line bg-elevated font-mono text-xs text-fg-2 active:bg-hover"
            >
              {key.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
