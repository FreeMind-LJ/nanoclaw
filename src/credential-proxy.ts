import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { resolveGroupIpcPath } from './group-folder.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Manages persistent MCP server processes and their Unix socket bridges.
 */
class McpManager {
  private servers = new Map<
    string,
    {
      process: ChildProcess;
      socketPath: string;
      unixServer: net.Server;
    }
  >();

  getSocketPath(groupFolder: string, serverName: string): string {
    const ipcDir = resolveGroupIpcPath(groupFolder);
    return path.join(ipcDir, `mcp_${serverName}.sock`);
  }

  ensureServer(groupFolder: string, serverName: string, chatJid?: string) {
    const key = `${groupFolder}:${serverName}`;
    if (this.servers.has(key)) return;

    if (serverName !== 'x-trade') {
      logger.warn(
        { serverName },
        'Unknown MCP server requested for persistent bridge',
      );
      return;
    }

    const socketPath = this.getSocketPath(groupFolder, serverName);

    // Clean up stale socket
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (e) {}
    }

    logger.info(
      { serverName, groupFolder, socketPath },
      'Starting persistent MCP shim bridge',
    );

    const mcpProc = spawn(
      '/usr/bin/python3',
      ['/home/ops/x-trade/mcp_shim.py'],
      {
        env: {
          ...process.env,
          PYTHONPATH: '/home/ops/x-trade',
          NANOCLAW_GROUP_FOLDER: groupFolder,
          ...(chatJid ? { NANOCLAW_CHAT_JID: chatJid } : {}),
        },
      },
    );

    mcpProc.stderr?.on('data', (d) =>
      logger.debug({ mcp: serverName, group: groupFolder }, d.toString()),
    );

    const unixServer = net.createServer((client) => {
      logger.debug(
        { serverName, groupFolder },
        'Container connected to MCP bridge',
      );

      // Bidirectional pipe: Container Socket <-> Python Stdio
      client.pipe(mcpProc.stdin!);
      mcpProc.stdout!.pipe(client);

      client.on('error', (err) =>
        logger.error({ err, serverName }, 'MCP client socket error'),
      );
    });

    mcpProc.on('exit', (code) => {
      logger.warn({ serverName, groupFolder, code }, 'MCP server exited');
      this.servers.delete(key);
      try {
        unixServer.close();
      } catch (e) {}
    });

    unixServer.listen(socketPath, () => {
      // Ensure the socket is accessible by the container user
      try {
        fs.chmodSync(socketPath, 0o777);
      } catch (e) {}
    });

    this.servers.set(key, { process: mcpProc, socketPath, unixServer });
  }
}

export const mcpManager = new McpManager();

// Re-implementing more cleanly
const mcpServers = new Map<string, ChildProcess>();

function getMcpServer(name: string): ChildProcess {
  let proc = mcpServers.get(name);
  if (!proc || proc.killed) {
    logger.info({ name }, 'Starting persistent MCP server');
    proc = spawn('/usr/bin/python3', ['-m', 'mcp_server.server'], {
      env: { ...process.env, PYTHONPATH: '/home/ops/x-trade' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    mcpServers.set(name, proc);
    proc.on('exit', () => mcpServers.delete(name));
  }
  return proc;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Handle MCP forwarding (legacy/debugging fallback)
        if (req.url?.startsWith('/mcp/')) {
          const serverName = req.url.slice(5);
          if (serverName === 'x-trade') {
            logger.info(
              { serverName },
              'Forwarding legacy MCP request (non-persistent)',
            );
            const mcp = spawn('/usr/bin/python3', ['-m', 'mcp_server.server'], {
              env: { ...process.env, PYTHONPATH: '/home/ops/x-trade' },
            });

            mcp.stdout.pipe(res);
            mcp.on('error', (err) => {
              logger.error({ err, serverName }, 'Failed to spawn MCP server');
              res.writeHead(500);
              res.end();
            });

            mcp.stdin.write(body);
            mcp.stdin.end();
            return;
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const basePath = upstreamUrl.pathname;
        const fullPath =
          basePath && basePath !== '/' ? basePath + req.url : req.url;

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: fullPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(52);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
