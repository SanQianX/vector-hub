import { spawn } from 'node:child_process';

/**
 * Native system folder picker.
 *
 * Windows drives the modern IFileDialog (the same folder picker Chrome/Edge
 * surface: breadcrumb bar, Quick Access sidebar) through an inline C# shim
 * spawned via PowerShell. Other platforms are not supported and yield a 501
 * so the UI can fall back to manual path entry.
 *
 * Ported from claude-ai-workbench's battle-tested folder-picker.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // a user may browse for minutes
const MAX_OUTPUT = 64 * 1024;

export interface PickFolderResult {
    /** Selected absolute path, or null when the user cancelled. */
    path: string | null;
}

export interface PickFolderError extends Error {
    status: number;
}

// One native dialog at a time: concurrent callers (double click, two tabs)
// share the in-flight pick instead of stacking modal dialogs.
let activePick: Promise<PickFolderResult> | null = null;

const WINDOWS_DIALOG_ARGS = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass'];
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
        // thread makes the activation legal; the topmost owner then keeps the
        // modal above the browser even when the OS still denies the change.
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
                dialog.SetTitle("选择知识库文件夹");
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
$picker = New-Object FolderPicker
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$cx = $wa.X + [int]($wa.Width / 2)
$cy = $wa.Y + [int]($wa.Height / 2)
if ($picker.ShowDialog([int]$cx, [int]$cy)) { Write-Output $picker.ResultPath }
`;

/** Opens the native folder picker. Resolves with `{ path: null }` on cancel. */
export function pickFolder(): Promise<PickFolderResult> {
    if (activePick) {
        return activePick;
    }
    const shared = pickFolderUnlocked().finally(() => {
        if (activePick == shared) {
            activePick = null;
        }
    });
    activePick = shared;
    return shared;
}

async function pickFolderUnlocked(): Promise<PickFolderResult> {
    if (process.platform != 'win32') {
        throw pickerError('native folder picker', Object.assign(new Error('unsupported platform'), { code: 'ENOENT' }));
    }
    const { stdout } = await runPicker('powershell.exe', [...WINDOWS_DIALOG_ARGS, '-Command', WINDOWS_DIALOG_SCRIPT]);
    return { path: parseSelectedPath(stdout) };
}

// Empty output means the user cancelled.
function parseSelectedPath(stdout: string): string | null {
    const value = String(stdout ?? '')
        .replace(/\u0000/g, '')
        .replace(/^\uFEFF/, '')
        .trim()
        .replace(/^"|"$/g, '');
    return value.length > 0 ? value : null;
}

function runPicker(command: string, args: string[]): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        const timer = setTimeout(
            () =>
                settle(() => {
                    killChild(child);
                    reject(pickerError(command, new Error(`timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`)));
                }),
            DEFAULT_TIMEOUT_MS,
        );
        timer.unref?.();
        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdout.length < MAX_OUTPUT) {
                stdout += String(chunk).slice(0, MAX_OUTPUT - stdout.length);
            }
        });
        child.stderr?.on('data', () => {
            /* cancellation chatter */
        });
        child.on('error', (error: Error) => settle(() => reject(pickerError(command, error))));
        child.on('close', () => settle(() => resolve({ stdout })));
    });
}

function pickerError(command: string, error: unknown): PickFolderError {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code == 'ENOENT') {
        return Object.assign(new Error(`${command} is not available on this system`), { status: 501 });
    }
    return Object.assign(new Error(`failed to run ${command}: ${message}`), { status: 500 });
}

function killChild(child: { kill?: () => void }): void {
    try {
        child.kill?.();
    } catch {
        /* already gone */
    }
}
