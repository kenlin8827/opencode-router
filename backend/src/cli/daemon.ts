import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getOcrHomeDir, getInfoFilePath, getLogFilePath, getPidFilePath, getRepoRootDir } from './paths.js';
import { DaemonInfo } from './types.js';
import { APP_VERSION } from '../version.js';
import { getAllClientStatuses } from './clients/index.js';
import { defaultGatewayPort } from './clients/base.js';

const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Exists but no permission to signal
  }
}

export function getRunningPid(): number | null {
  const pidFile = getPidFilePath();
  if (!fs.existsSync(pidFile)) return null;

  try {
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) {
      fs.unlinkSync(pidFile);
      return null;
    }
    if (isProcessAlive(pid)) {
      return pid;
    }
    // Stale PID file
    fs.unlinkSync(pidFile);
    return null;
  } catch {
    return null;
  }
}

export function getDaemonInfo(): DaemonInfo | null {
  const infoFile = getInfoFilePath();
  if (!fs.existsSync(infoFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function checkServerHealth(port = defaultGatewayPort(), host = '127.0.0.1'): Promise<{ ok: boolean; data?: any }> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch {
    // offline
  }
  return { ok: false };
}

export function resolveRuntimeBinary(): { bin: string; args: string[] } {
  const repoDir = getRepoRootDir();
  const entryTs = path.join(repoDir, 'backend', 'src', 'index.ts');
  const entryJs = path.join(repoDir, 'dist', 'index.js');

  // Check bun availability
  const bunPath = process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', 'bun') : 'bun';
  // Common paths on Windows: D:\dev\bun\bin\bun.exe or bun in PATH
  const candidates = [
    'bun',
    'D:\\dev\\bun\\bin\\bun.exe',
    path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { bin: c, args: ['run', entryTs] };
    }
  }

  // Fallback to node
  if (fs.existsSync(entryJs)) {
    return { bin: 'node', args: [entryJs] };
  }
  return { bin: 'npx', args: ['tsx', entryTs] };
}

export async function startDaemon(options: { port?: number; host?: string; daemon?: boolean } = {}): Promise<{
  success: boolean;
  pid: number;
  port: number;
  message: string;
}> {
  const existingPid = getRunningPid();
  const port = options.port || defaultGatewayPort();
  const host = options.host || '127.0.0.1';

  if (existingPid) {
    const health = await checkServerHealth(port, host);
    return {
      success: true,
      pid: existingPid,
      port,
      message: `OCR gateway is already running (PID: ${existingPid}, status: ${health.ok ? 'online' : 'initializing'}).`,
    };
  }

  const logFile = getLogFilePath();
  const pidFile = getPidFilePath();
  const infoFile = getInfoFilePath();
  const repoDir = getRepoRootDir();

  const { bin, args } = resolveRuntimeBinary();

  let pid: number;

  if (IS_WINDOWS) {
    // Windows: Use Win32_Process.Create via CIM with Base64 encoding to guarantee zero quote-escaping errors and true breakaway daemon
    const commandLine = `"${bin}" ${args.map((a) => `"${a}"`).join(' ')}`;
    const b64Cmd = Buffer.from(commandLine).toString('base64');
    const psCmd = `$cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Cmd}')); $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = '${repoDir.replace(/'/g, "''")}' }; $res.ProcessId`;
    const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
      windowsHide: true,
      encoding: 'utf8',
    });
    pid = parseInt(res.stdout?.trim() || '0', 10);
  } else {
    const logFd = fs.openSync(logFile, 'a');
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: host,
      NODE_ENV: 'production',
    };
    const child = spawn(bin, args, {
      cwd: repoDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
      shell: false,
    });
    pid = child.pid || 0;
    child.unref();
  }

  if (!pid) {
    return {
      success: false,
      pid: 0,
      port,
      message: 'Failed to spawn OCR background process.',
    };
  }

  fs.writeFileSync(pidFile, String(pid), 'utf8');
  fs.writeFileSync(
    infoFile,
    JSON.stringify(
      {
        pid,
        port,
        host,
        startTime: new Date().toISOString(),
        version: APP_VERSION,
      },
      null,
      2
    ),
    'utf8'
  );

  // Wait for health check up to 5 seconds
  let online = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const health = await checkServerHealth(port, host);
    if (health.ok) {
      online = true;
      break;
    }
  }

  return {
    success: true,
    pid,
    port,
    message: online
      ? `OCR gateway started successfully in background (PID: ${pid}, Port: ${port})`
      : `OCR gateway started (PID: ${pid}), waiting for initial synchronization... Check ${logFile} for details.`,
  };
}

export async function stopDaemon(): Promise<{ success: boolean; message: string }> {
  const pid = getRunningPid();
  if (!pid) {
    return { success: true, message: 'OCR gateway is not currently running.' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
    if (err.code !== 'ESRCH') {
      try {
        if (IS_WINDOWS) {
          spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // ignore
      }
    }
  }

  // Poll for process exit
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isProcessAlive(pid)) {
      break;
    }
  }

  if (isProcessAlive(pid)) {
    try {
      if (IS_WINDOWS) {
        spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // ignore
    }
  }

  const pidFile = getPidFilePath();
  const infoFile = getInfoFilePath();
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  if (fs.existsSync(infoFile)) fs.unlinkSync(infoFile);

  return { success: true, message: `OCR gateway (PID: ${pid}) has been stopped.` };
}

export async function restartDaemon(options: { port?: number; host?: string } = {}): Promise<{
  success: boolean;
  message: string;
}> {
  await stopDaemon();
  await new Promise((r) => setTimeout(r, 800));
  const res = await startDaemon(options);
  return {
    success: res.success,
    message: `OCR gateway restarted: ${res.message}`,
  };
}

export async function getStatusOutput(): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
  uptime?: string;
  health?: any;
  clients: any[];
}> {
  const pid = getRunningPid();
  const info = getDaemonInfo();
  const port = info?.port || defaultGatewayPort();
  const host = info?.host || '127.0.0.1';

  let health: any = null;
  if (pid) {
    const res = await checkServerHealth(port, host);
    if (res.ok) {
      health = res.data;
    }
  }

  const clients = getAllClientStatuses();

  let uptime: string | undefined;
  if (info?.startTime) {
    const diffSec = Math.floor((Date.now() - new Date(info.startTime).getTime()) / 1000);
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;
    uptime = `${hours}h ${mins}m ${secs}s`;
  }

  return {
    running: Boolean(pid),
    pid,
    port,
    uptime,
    health,
    clients,
  };
}

export async function openBrowserUrl(url: string): Promise<void> {
  if (IS_WINDOWS) {
    spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true });
  } else if (IS_MACOS) {
    spawn('open', [url], { detached: true });
  } else {
    spawn('xdg-open', [url], { detached: true });
  }
}

export async function launchWeb(options: { port?: number } = {}): Promise<void> {
  const status = await getStatusOutput();
  const port = options.port || status.port || defaultGatewayPort();

  if (!status.running) {
    console.log('[OCR] Gateway is not running. Starting background service first...');
    const startRes = await startDaemon({ port });
    console.log(`[OCR] ${startRes.message}`);
  }

  const targetUrl = `http://127.0.0.1:${port}/`;
  console.log(`[OCR] Opening Web Dashboard at: ${targetUrl}`);
  await openBrowserUrl(targetUrl);
}

export async function launchDesktop(options: { port?: number } = {}): Promise<void> {
  const status = await getStatusOutput();
  const port = options.port || status.port || defaultGatewayPort();

  if (!status.running) {
    console.log('[OCR] Gateway is not running. Starting background service first...');
    await startDaemon({ port });
  }

  // Look for native Tauri desktop binary candidates
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'opencode-router', 'opencode-router-desktop.exe'),
    path.join(getRepoRootDir(), 'desktop', 'src-tauri', 'target', 'release', 'opencode-router-desktop.exe'),
  ];

  let desktopBin: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      desktopBin = c;
      break;
    }
  }

  if (desktopBin) {
    console.log(`[OCR] Launching native desktop application (${desktopBin})...`);
    spawn(desktopBin, [], { detached: true, stdio: 'ignore', windowsHide: false });
  } else {
    console.log('[OCR] 💡 Native desktop client (Tauri) package not found.');
    console.log('      Seamlessly opening Web Console in your browser...');
    console.log('      (Download native desktop installers at https://github.com/kenlin8827/opencode-router/releases)');
    await launchWeb(options);
  }
}
