// Per-terminal resource usage: samples the OS process table once, builds the
// parent→children tree, and sums CPU/RSS over each terminal's process subtree
// (a pty's shell spawns node/claude/git/... — the terminal's real cost is the
// whole subtree). One PowerShell/ps call per sample, throttled, on demand.

const os = require('os');
const { execFile } = require('child_process');

const MIN_INTERVAL_MS = 2500;

let lastSample = 0;
let lastTable = null; // pid -> { ppid, mem, cpuTime? , cpuPct? }
let prevCpuTimes = null; // Windows: pid -> { cpuTime, at } for CPU% deltas
let inFlight = null;

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// One flat process table: pid -> { ppid, mem(bytes), cpuPct }
async function readTable() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress',
    ]);
    const list = JSON.parse(out);
    const now = Date.now();
    const cores = os.cpus().length || 1;
    const table = new Map();
    const nextCpu = new Map();
    for (const p of Array.isArray(list) ? list : [list]) {
      const pid = p.ProcessId;
      if (pid == null) continue;
      const cpuTime = (Number(p.UserModeTime) + Number(p.KernelModeTime)) / 1e4; // 100ns → ms
      nextCpu.set(pid, { cpuTime, at: now });
      let cpuPct = 0;
      const prev = prevCpuTimes && prevCpuTimes.get(pid);
      if (prev && now > prev.at) {
        cpuPct = Math.max(0, ((cpuTime - prev.cpuTime) / (now - prev.at)) * 100 / cores);
      }
      table.set(pid, { ppid: p.ParentProcessId, mem: Number(p.WorkingSetSize) || 0, cpuPct });
    }
    prevCpuTimes = nextCpu;
    return table;
  }
  // macOS / Linux: %cpu comes straight from ps
  const out = await run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=']);
  const table = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)/);
    if (m) table.set(+m[1], { ppid: +m[2], mem: +m[3] * 1024, cpuPct: +m[4] });
  }
  return table;
}

function subtreeTotals(table, childrenIdx, rootPid) {
  const totals = { cpu: 0, mem: 0, count: 0 };
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = table.get(pid);
    if (!p) continue;
    totals.cpu += p.cpuPct;
    totals.mem += p.mem;
    totals.count++;
    for (const c of childrenIdx.get(pid) || []) stack.push(c);
  }
  return totals;
}

// roots: [{ key, pid }] — key is echoed back (a termId, or 'app').
async function sample(roots) {
  const now = Date.now();
  if (!lastTable || now - lastSample >= MIN_INTERVAL_MS) {
    if (!inFlight) {
      inFlight = readTable()
        .then((t) => {
          lastTable = t;
          lastSample = Date.now();
        })
        .catch(() => {})
        .finally(() => {
          inFlight = null;
        });
    }
    await inFlight;
  }
  const table = lastTable || new Map();
  const childrenIdx = new Map();
  for (const [pid, p] of table) {
    if (!childrenIdx.has(p.ppid)) childrenIdx.set(p.ppid, []);
    childrenIdx.get(p.ppid).push(pid);
  }
  const byKey = {};
  for (const r of roots || []) {
    if (!r || r.pid == null) continue;
    byKey[r.key] = subtreeTotals(table, childrenIdx, Number(r.pid));
  }
  return {
    byKey,
    app: subtreeTotals(table, childrenIdx, process.pid),
    sys: {
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      cores: os.cpus().length || 1,
    },
    sampledAt: lastSample,
  };
}

module.exports = { sample };
