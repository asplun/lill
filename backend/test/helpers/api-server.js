import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

/**
 * 启动一次测试用 API 服务。
 * 端口是「先探测再绑定」，并行测试文件之间可能抢到同一个空闲端口，
 * 因此对 EADDRINUSE 做有限重试（见 startApiServer）。
 */
async function launchOnce() {
  const tempDir = await mkdtemp(join(tmpdir(), 'lill-security-test-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(tempDir, 'lill.db'),
      UPLOAD_DIR: join(tempDir, 'uploads'),
      THEMES_DIR: join(tempDir, 'themes'),
      PLUGINS_DIR: join(tempDir, 'plugins'),
      JWT_SECRET: 'test-only-secret-not-for-production',
      FRONTEND_URL: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  const request = async (method, path, options = {}) => {
    const headers = { ...options.headers };
    const config = { method, headers, signal: AbortSignal.timeout(options.timeout || 5000) };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      config.body = JSON.stringify(options.body);
    }
    const response = await fetch(baseUrl + path, config);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, payload };
  };

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`API server exited before readiness:\n${output}`);
    }
    try {
      const response = await request('GET', '/api/v1/install/status');
      ready = response.status === 200;
    } catch {}
    if (!ready) await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }

  if (!ready) {
    child.kill('SIGKILL');
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`API server did not become ready:\n${output}`);
  }

  return {
    baseUrl,
    dbPath: join(tempDir, 'lill.db'),
    request,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise(resolveDelay => setTimeout(resolveDelay, 3000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      }
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function startApiServer({ attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await launchOnce();
    } catch (error) {
      lastError = error;
      if (!/EADDRINUSE/.test(error.message)) throw error;
    }
  }
  throw lastError;
}
