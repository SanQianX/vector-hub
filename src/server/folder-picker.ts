import { spawn } from 'node:child_process';

/**
 * UNIFIED native folder picker — three copies of this file are kept in
 * lockstep (identical logic; only the module syntax differs):
 *   vector-hub             src/server/folder-picker.ts        (TypeScript twin)
 *   ai-coding-event-bridge packages/console/src/pick-folder.js
 *   claude-ai-workbench    packages/server/lib/folder-picker.js
 *
 * Windows keeps the dialog the user already knows — the modern IFileDialog
 * (the same folder picker Chrome/Edge surface: breadcrumb bar, Quick Access
 * sidebar) driven by the battle-tested inline C# shim, with the
 * AttachThreadInput foreground fix so the modal opens above the browser.
 * What changed is the process model: spawning powershell.exe and running
 * Add-Type (a full C# compilation) on every click cost 1-3s or more, so the
 * helper is now started once in the background when the server boots
 * (warmFolderPicker) and stays resident, serving every pick over a
 * newline-framed stdin/stdout protocol. A click only writes one line and
 * the dialog appears in milliseconds. The helper self-exits when its stdin
 * pipe breaks, and the exit hook below kills it on shutdown.
 *
 * Other platforms keep one-shot helpers: zenity on Linux, osascript on macOS.
 *
 * Wire protocol (requests are pure ASCII; each reply is one line):
 *   -> ping          <- !PONG
 *   -> pick <x> <y>  <- !OK <selected path>
 *   -> pick - -      <- !CANCEL          (user dismissed the dialog)
 *                    <- !ERR <message>   (helper-side failure)
 *   and the first line after startup is !READY.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // a user may browse for minutes
const STARTUP_TIMEOUT_MS = 60 * 1000; // powershell.exe start + Add-Type compile
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_PICKER_TITLE = '选择文件夹';

export interface PickFolderResult {
    /** Selected absolute path, or null when the user cancelled. */
    path: string | null;
}

export interface PickFolderError extends Error {
    status: number;
}

export interface WindowRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PickFolderOptions {
    /** Overrides process.platform (tests). */
    platform?: string;
    /** Injects the process spawner (tests). */
    spawn?: PickerSpawn;
    /** Dialog lifetime timeout in ms. */
    timeoutMs?: number;
    /** Helper startup (powershell + Add-Type) timeout in ms. */
    startupTimeoutMs?: number;
    /** Browser window rect in screen coordinates; centers the dialog on it. */
    windowRect?: WindowRect;
    /** Dialog title, baked into the helper at startup. */
    title?: string;
}

type PickerStream = {
    write: (chunk: string) => unknown;
    on?: (event: string, listener: (chunk?: unknown) => void) => unknown;
    ref?: () => void;
    unref?: () => void;
};
type PickerChild = {
    stdin: PickerStream | null;
    stdout?: PickerStream | null;
    stderr?: PickerStream | null;
    kill?: () => void;
    ref?: () => void;
    unref?: () => void;
    on: (event: string, listener: (...args: any[]) => void) => unknown;
};
type PickerSpawn = (
    command: string,
    args: string[],
    options: { windowsHide: boolean; stdio: string[] },
) => PickerChild;

// One native dialog at a time: concurrent callers (double click, two tabs)
// share the in-flight pick instead of stacking modal dialogs.
let activePick: Promise<PickFolderResult> | null = null;

const WINDOWS_DIALOG_ARGS = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass'];

// Number.isFinite alone does not narrow `number | undefined`, so the option
// timeout ternaries from the JS twin go through this helper in the TS twin.
function resolveTimeout(value: number | undefined, fallback: number): number {
    return value != undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
const WINDOWS_DIALOG_SCRIPT = `\
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$cs = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class FolderPicker {
    public string ResultPath { get; private set; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public bool ShowDialog(int cx, int cy) {
        // The dialog centers on its owner, so the owner is a 1x1 transparent
        // topmost window parked at the anchor point (browser window center,
        // or the primary screen center when no anchor was supplied).
        var owner = new Form();
        owner.StartPosition = FormStartPosition.Manual;
        owner.FormBorderStyle = FormBorderStyle.None;
        owner.ShowInTaskbar = false;
        owner.TopMost = true;
        owner.Size = new System.Drawing.Size(1, 1);
        try {
            var area = Screen.FromPoint(new System.Drawing.Point(cx, cy)).WorkingArea;
            if (cx < area.Left || cx > area.Right) cx = area.Left + area.Width / 2;
            if (cy < area.Top || cy > area.Bottom) cy = area.Top + area.Height / 2;
        } catch { }
        owner.Location = new System.Drawing.Point(cx, cy);
        owner.Opacity = 0;
        owner.Show();
        // A background process normally may not steal the foreground from the
        // browser. Attaching our input thread to the foreground window's
        // thread makes the activation legal (classic AttachThreadInput
        // technique); the topmost owner then keeps the modal above the
        // browser even when the OS still denies the focus change.
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint thisThread = GetCurrentThreadId();
        bool attached = fgThread != thisThread && fgThread != 0 && AttachThreadInput(thisThread, fgThread, true);
        try {
            SetForegroundWindow(owner.Handle);
            owner.Activate();
        } finally {
            if (attached) AttachThreadInput(thisThread, fgThread, false);
        }
        try {
            var dialog = (IFileDialog)(new FileOpenDialogRCW());
            try {
                dialog.SetOptions(FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST);
                dialog.SetTitle("__PICKER_TITLE__");
                int hr = dialog.Show(owner.Handle);
                if (hr != 0) return false;
                IShellItem item;
                dialog.GetResult(out item);
                IntPtr pathPtr;
                item.GetDisplayName(SIGDN.FILESYSPATH, out pathPtr);
                ResultPath = Marshal.PtrToStringUni(pathPtr);
                Marshal.FreeCoTaskMem(pathPtr);
                Marshal.ReleaseComObject(item);
                return true;
            } finally { Marshal.ReleaseComObject(dialog); }
        } finally { owner.Close(); }
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW { }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        // Full vtable order matters: COM slots before GetDisplayName must be
        // declared even though this picker never calls them.
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        IShellItem GetParent();
        [PreserveSig] int GetDisplayName(SIGDN sigdnName, out IntPtr ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint);
    }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(FOS fos);
        void GetOptions(out FOS pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    private enum SIGDN : uint { FILESYSPATH = 0x80058000 }

    [Flags]
    private enum FOS : uint {
        PICKFOLDERS = 0x20,
        FORCEFILESYSTEM = 0x40,
        PATHMUSTEXIST = 0x800,
    }
}
"@
Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms.dll,System.Drawing.dll
[Console]::Out.WriteLine('!READY')
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq 'ping') { [Console]::Out.WriteLine('!PONG'); continue }
    if (-not $line.StartsWith('pick ')) { continue }
    $bits = $line.Substring(5) -split ' '
    $cx = $bits[0]
    $cy = $bits[1]
    if ($null -eq $cx -or $cx -eq '' -or $cx -eq '-' -or $null -eq $cy -or $cy -eq '' -or $cy -eq '-') {
        $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $cx = $wa.X + [int]($wa.Width / 2)
        $cy = $wa.Y + [int]($wa.Height / 2)
    }
    $picker = New-Object FolderPicker
    try {
        if ($picker.ShowDialog([int]$cx, [int]$cy)) {
            [Console]::Out.WriteLine('!OK ' + $picker.ResultPath)
        } else {
            [Console]::Out.WriteLine('!CANCEL')
        }
    } catch {
        [Console]::Out.WriteLine('!ERR ' + $_.Exception.Message)
    }
}
`;

// The title lives inside the C# source that Add-Type compiles, so it is
// baked in when the helper starts; a different title restarts the helper.
// Quotes, backslashes, dollars and control characters would break either
// the C# literal or the PowerShell here-string and are stripped.
function sanitizeTitle(title: string | null | undefined): string {
    const value = String(title ?? '')
        .replace(/["\\`$\r\n\t\u0000]/g, '')
        .trim()
        .slice(0, 128);
    return value.length > 0 ? value : DEFAULT_PICKER_TITLE;
}

function windowsWorkerScript(title: string | null | undefined): string {
    return WINDOWS_DIALOG_SCRIPT.replace('__PICKER_TITLE__', sanitizeTitle(title));
}

// The dialog centers on its owner, and the owner is parked at the caller's
// anchor point (the browser window center) — `windowRect` is the UI page's
// {x, y, width, height} in screen coordinates. Anything malformed falls
// back to the '-' markers, which make the helper center on the primary
// screen instead.
function anchorPoint(windowRect: WindowRect | undefined): [number, number] | null {
    if (windowRect && [windowRect.x, windowRect.y, windowRect.width, windowRect.height].every(Number.isFinite)) {
        const x = Math.round(windowRect.x + Math.min(Math.max(windowRect.width, 0), 32768) / 2);
        const y = Math.round(windowRect.y + Math.min(Math.max(windowRect.height, 0), 32768) / 2);
        // Guard against absurd coordinates; Screen.FromPoint clamps the rest.
        if (Math.abs(x) <= 100000 && Math.abs(y) <= 100000) return [x, y];
    }
    return null;
}

/* ---- resident Windows helper (warm worker) ---- */

interface PendingPick {
    resolve: (result: PickFolderResult) => void;
    reject: (error: PickFolderError) => void;
    timer: ReturnType<typeof setTimeout>;
}
interface PendingPing {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
}
interface PickerWorker {
    child: PickerChild | null;
    ready: Promise<void> | null;
    title: string | null;
    buffer: string;
    pending: PendingPick | null;
    ping: PendingPing | null;
    resolveReady: (() => void) | null;
    starting: boolean;
}

// One helper per spawn function: the real server shares node's spawn, so a
// single resident process serves every pick; injected test spawns each get
// an isolated worker. A strong set tracks live workers for the exit hook.
const workers = new WeakMap<PickerSpawn, PickerWorker>();
const liveWorkers = new Set<PickerWorker>();

function workerFor(doSpawn: PickerSpawn): PickerWorker {
    let worker = workers.get(doSpawn);
    if (!worker) {
        worker = { child: null, ready: null, title: null, buffer: '', pending: null, ping: null, resolveReady: null, starting: false };
        workers.set(doSpawn, worker);
    }
    return worker;
}

// While a request is in flight (helper startup, an open dialog, a ping) the
// worker's streams keep node alive so the reply is never lost; when idle
// they are unref'd again, letting a one-shot script exit once it is done.
// A listening server never notices either way.
function syncWorkerRefs(worker: PickerWorker): void {
    const held = Boolean(worker.pending || worker.ping || worker.starting);
    const child = worker.child;
    if (!child) return;
    [child, child.stdin, child.stdout, child.stderr].forEach((handle) => {
        if (!handle) return;
        if (held) {
            handle.ref?.();
        } else {
            handle.unref?.();
        }
    });
}

function ensureWorker(worker: PickerWorker, doSpawn: PickerSpawn, title: string, startupTimeoutMs: number): Promise<void> {
    if (worker.title !== title) {
        killWorker(worker);
        worker.title = title;
    }
    if (!worker.ready) {
        worker.ready = startWorker(worker, doSpawn, startupTimeoutMs).catch((error) => {
            worker.ready = null;
            throw error;
        });
    }
    return worker.ready;
}

function startWorker(worker: PickerWorker, doSpawn: PickerSpawn, startupTimeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = doSpawn('powershell.exe', [...WINDOWS_DIALOG_ARGS, '-Command', windowsWorkerScript(worker.title)], {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error: unknown) {
            reject(pickerError('powershell.exe', error));
            return;
        }
        worker.child = child;
        worker.starting = true;
        worker.buffer = '';
        liveWorkers.add(worker);
        [child.stdin, child.stdout, child.stderr].forEach((stream) => {
            if (stream && stream.on) stream.on('error', () => { /* EPIPE when the helper died */ });
        });
        syncWorkerRefs(worker);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            killWorker(worker);
            reject(Object.assign(
                new Error(`folder picker helper failed to start within ${Math.round(startupTimeoutMs / 1000)}s`),
                { status: 500 },
            ));
        }, startupTimeoutMs);
        timer.unref?.();
        worker.resolveReady = () => {
            if (settled) return;
            settled = true;
            worker.starting = false;
            clearTimeout(timer);
            syncWorkerRefs(worker);
            resolve();
        };
        child.stdout?.on?.('data', (chunk?: unknown) => {
            if (worker.buffer.length < MAX_OUTPUT) {
                worker.buffer += String(chunk ?? '').slice(0, MAX_OUTPUT - worker.buffer.length);
            }
            drainWorkerLines(worker);
        });
        child.stderr?.on?.('data', () => { /* startup chatter */ });
        child.on('error', (error: unknown) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(pickerError('powershell.exe', error));
            }
            worker.starting = false;
            detachWorker(worker);
        });
        child.on('close', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(Object.assign(new Error('folder picker helper exited before becoming ready'), { status: 500 }));
            }
            worker.starting = false;
            detachWorker(worker);
        });
    });
}

function drainWorkerLines(worker: PickerWorker): void {
    let index = worker.buffer.indexOf('\n');
    while (index >= 0) {
        const line = worker.buffer.slice(0, index).replace(/\r$/, '').replace(/^\uFEFF/, '').trim();
        worker.buffer = worker.buffer.slice(index + 1);
        handleWorkerLine(worker, line);
        index = worker.buffer.indexOf('\n');
    }
}

function handleWorkerLine(worker: PickerWorker, line: string): void {
    if (line === '!READY') {
        worker.resolveReady?.();
    } else if (line === '!PONG') {
        const ping = worker.ping;
        if (ping) {
            worker.ping = null;
            clearTimeout(ping.timer);
            syncWorkerRefs(worker);
            ping.resolve();
        }
    } else if (line === '!CANCEL') {
        settleWorkerPick(worker, (pending) => pending.resolve({ path: null }));
    } else if (line.startsWith('!OK ')) {
        const path = parseSelectedPath(line.slice(4), false);
        settleWorkerPick(worker, (pending) => pending.resolve({ path }));
    } else if (line.startsWith('!ERR ')) {
        settleWorkerPick(worker, (pending) => pending.reject(pickerError(
            'folder picker helper',
            Object.assign(new Error(line.slice(5)), { status: 500 }),
        )));
        killWorker(worker);
    }
    /* anything else is noise and ignored */
}

function settleWorkerPick(worker: PickerWorker, finish: (pending: PendingPick) => void): void {
    const pending = worker.pending;
    if (!pending) return;
    worker.pending = null;
    clearTimeout(pending.timer);
    finish(pending);
    syncWorkerRefs(worker);
}

async function pickViaWindowsWorker(options: PickFolderOptions): Promise<PickFolderResult> {
    const doSpawn = (options.spawn ?? spawn) as unknown as PickerSpawn;
    const timeoutMs = resolveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const startupTimeoutMs = resolveTimeout(options.startupTimeoutMs, STARTUP_TIMEOUT_MS);
    const worker = workerFor(doSpawn);
    await ensureWorker(worker, doSpawn, sanitizeTitle(options.title), startupTimeoutMs);
    const anchor = anchorPoint(options.windowRect);
    return await new Promise<PickFolderResult>((resolve, reject) => {
        const pending: PendingPick = { resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
        pending.timer = setTimeout(() => {
            // The helper is stuck mid-dialog and its state is unknown, so settle
            // first (with the timeout message), then kill it — the next pick
            // respawns a fresh helper.
            settleWorkerPick(worker, (p) => p.reject(Object.assign(
                new Error(`folder picker timed out after ${Math.round(timeoutMs / 1000)}s`),
                { status: 500 },
            )));
            killWorker(worker);
        }, timeoutMs);
        pending.timer.unref?.();
        worker.pending = pending;
        syncWorkerRefs(worker);
        if (!worker.child || !worker.child.stdin) {
            settleWorkerPick(worker, (p) => p.reject(Object.assign(
                new Error('folder picker helper is not running'),
                { status: 500 },
            )));
            return;
        }
        try {
            worker.child.stdin.write(anchor ? `pick ${anchor[0]} ${anchor[1]}\n` : 'pick - -\n');
        } catch (error: unknown) {
            settleWorkerPick(worker, (p) => p.reject(pickerError('folder picker helper', error)));
        }
    });
}

function detachWorker(worker: PickerWorker): void {
    liveWorkers.delete(worker);
    worker.child = null;
    worker.ready = null; // the helper died: force the next pick to respawn
    worker.starting = false;
    worker.buffer = '';
    if (worker.pending) {
        settleWorkerPick(worker, (pending) => pending.reject(Object.assign(
            new Error('folder picker helper exited unexpectedly'),
            { status: 500 },
        )));
    }
}

function killWorker(worker: PickerWorker): void {
    const child = worker.child;
    worker.child = null;
    worker.ready = null;
    worker.starting = false;
    liveWorkers.delete(worker);
    if (worker.pending) {
        settleWorkerPick(worker, (pending) => pending.reject(Object.assign(
            new Error('folder picker helper was stopped'),
            { status: 500 },
        )));
    }
    try { child?.kill?.(); } catch { /* already gone */ }
}

process.on('exit', () => {
    for (const worker of [...liveWorkers]) killWorker(worker);
});

/* ---- public API ---- */

/** Opens the native folder picker. Resolves with `{ path: null }` on cancel. */
export function pickFolder(options: PickFolderOptions = {}): Promise<PickFolderResult> {
    if (activePick) {
        return activePick;
    }
    const shared = pickFolderUnlocked(options);
    activePick = shared;
    // Release on settle; the attached handler also means a dropped shared
    // rejection never surfaces as unhandled.
    const release = () => { if (activePick == shared) activePick = null; };
    shared.then(release, release);
    return shared;
}

async function pickFolderUnlocked(options: PickFolderOptions): Promise<PickFolderResult> {
    const platform = options.platform ?? process.platform;
    if (platform == 'win32') {
        return pickViaWindowsWorker(options);
    }
    const doSpawn = (options.spawn ?? spawn) as unknown as PickerSpawn;
    const timeoutMs = resolveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const run = (command: string, args: string[]) => runOneShot(command, args, doSpawn, timeoutMs);
    try {
        const { stdout } = await run('zenity', ['--file-selection', '--directory']);
        return { path: parseSelectedPath(stdout, false) };
    } catch (error) {
        // Only "not installed" falls through to osascript; real failures (crash,
        // timeout) are already terminal.
        if ((error as { status?: number })?.status !== 501) throw error;
    }
    const { stdout } = await run('osascript', ['-e', 'POSIX path of (choose folder)']);
    return { path: parseSelectedPath(stdout, true) };
}

/**
 * Pre-starts the resident Windows helper (powershell.exe + one Add-Type
 * compile) so the first user click only writes a stdin line. Call once at
 * server startup; resolves false instead of throwing so a broken helper
 * never takes the server down — the next pick retries the spawn.
 */
export async function warmFolderPicker(options: PickFolderOptions = {}): Promise<boolean> {
    if ((options.platform ?? process.platform) != 'win32') return false;
    try {
        const doSpawn = (options.spawn ?? spawn) as unknown as PickerSpawn;
        const startupTimeoutMs = resolveTimeout(options.startupTimeoutMs, STARTUP_TIMEOUT_MS);
        await ensureWorker(workerFor(doSpawn), doSpawn, sanitizeTitle(options.title), startupTimeoutMs);
        return true;
    } catch {
        return false;
    }
}

/**
 * Health probe for the resident helper: round-trips `ping`/`!PONG` and
 * resolves with the elapsed milliseconds (null off Windows). Also handy for
 * measuring the warm click latency.
 */
export async function pingFolderPicker(options: PickFolderOptions = {}): Promise<number | null> {
    if ((options.platform ?? process.platform) != 'win32') return null;
    const doSpawn = (options.spawn ?? spawn) as unknown as PickerSpawn;
    const worker = workerFor(doSpawn);
    const startupTimeoutMs = resolveTimeout(options.startupTimeoutMs, STARTUP_TIMEOUT_MS);
    await ensureWorker(worker, doSpawn, sanitizeTitle(options.title), startupTimeoutMs);
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
        const ping = {
            resolve,
            timer: setTimeout(() => {
                worker.ping = null;
                killWorker(worker);
                reject(Object.assign(new Error('folder picker ping timed out'), { status: 500 }));
            }, 5000),
        };
        ping.timer.unref?.();
        worker.ping = ping;
        syncWorkerRefs(worker);
        if (!worker.child || !worker.child.stdin) {
            worker.ping = null;
            clearTimeout(ping.timer);
            reject(Object.assign(new Error('folder picker helper is not running'), { status: 500 }));
            return;
        }
        try {
            worker.child.stdin.write('ping\n');
        } catch (error: unknown) {
            worker.ping = null;
            clearTimeout(ping.timer);
            reject(pickerError('folder picker helper', error));
        }
    });
    return Date.now() - started;
}

// Empty output means the user cancelled: every backend keeps that contract.
export function parseSelectedPath(stdout: string | null | undefined, stripTrailingSlashes: boolean): string | null {
    let value = String(stdout ?? '').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
    value = value.replace(/^"|"$/g, '');
    if (stripTrailingSlashes && value) value = value.replace(/\/+$/, '') || '/';
    return value || null;
}

function runOneShot(
    command: string,
    args: string[],
    doSpawn: PickerSpawn,
    timeoutMs: number,
): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = doSpawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error: unknown) {
            reject(pickerError(command, error));
            return;
        }
        let stdout = '';
        let settled = false;
        const settle = (finish: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            finish();
        };
        const timer = setTimeout(() => settle(() => {
            killChild(child);
            reject(Object.assign(
                new Error(`folder picker timed out after ${Math.round(timeoutMs / 1000)}s`),
                { status: 500 },
            ));
        }), timeoutMs);
        timer.unref?.();
        child.stdout?.on?.('data', (chunk?: unknown) => {
            if (stdout.length < MAX_OUTPUT) stdout += String(chunk ?? '').slice(0, MAX_OUTPUT - stdout.length);
        });
        child.stderr?.on?.('data', () => { /* cancellation chatter */ });
        child.on('error', (error: unknown) => settle(() => reject(pickerError(command, error))));
        child.on('close', () => settle(() => resolve({ stdout })));
    });
}

function pickerError(command: string, error: unknown): PickFolderError {
    if ((error as { code?: string })?.code == 'ENOENT') {
        return Object.assign(new Error(`${command} is not available on this system`), { status: 501 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(`failed to run ${command}: ${message}`), { status: 500 });
}

function killChild(child: PickerChild | null): void {
    try { child?.kill?.(); } catch { /* already gone */ }
}
