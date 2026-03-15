import WebSocket from 'ws';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const MAX_TEXT_LENGTH = 1800;
const RECONNECT_DELAYS_MS = [1000, 3000, 5000, 10000, 30000];
const INTENTS = {
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

interface QQChannelOpts {
  onMessage: ChannelOpts['onMessage'];
  onChatMetadata: ChannelOpts['onChatMetadata'];
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface QQTokenCache {
  token: string;
  expiresAt: number;
}

interface QQGatewayPayload {
  op?: number;
  s?: number | null;
  t?: string;
  d?: any;
}

interface QQAuthor {
  id?: string;
  username?: string;
  user_openid?: string;
  member_openid?: string;
}

interface QQMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: QQAuthor;
  group_openid?: string;
}

export class QQChannel implements Channel {
  name = 'qq';

  private opts: QQChannelOpts;
  private appId: string;
  private clientSecret: string;
  private platformToken?: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeq: number | null = null;
  private connected = false;
  private shuttingDown = false;
  private reconnectAttempts = 0;
  private tokenCache: QQTokenCache | null = null;
  private lastInboundMessageId = new Map<string, string>();
  private nextMessageSeq = Math.floor(Date.now() / 1000);

  constructor(
    appId: string,
    clientSecret: string,
    platformToken: string | undefined,
    opts: QQChannelOpts,
  ) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.platformToken = platformToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    await this.openGateway();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:c2c:') || jid.startsWith('qq:group:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    logger.info('QQ channel stopped');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      const chunks = this.chunkText(text, MAX_TEXT_LENGTH);
      const replyToMessageId = this.lastInboundMessageId.get(jid);
      let msgSeq = this.nextMessageSeq;

      for (const chunk of chunks) {
        const payload: Record<string, unknown> = {
          content: chunk,
          msg_type: 0,
          msg_seq: msgSeq,
        };

        if (replyToMessageId) {
          payload.msg_id = replyToMessageId;
        }

        let response: unknown;
        if (jid.startsWith('qq:c2c:')) {
          const openid = jid.replace(/^qq:c2c:/, '');
          response = await this.apiRequest(
            accessToken,
            'POST',
            `/v2/users/${openid}/messages`,
            payload,
          );
        } else if (jid.startsWith('qq:group:')) {
          const groupOpenid = jid.replace(/^qq:group:/, '');
          response = await this.apiRequest(
            accessToken,
            'POST',
            `/v2/groups/${groupOpenid}/messages`,
            payload,
          );
        } else {
          logger.warn({ jid }, 'Unsupported QQ JID');
          return;
        }

        logger.info(
          { jid, msgSeq, replyToMessageId, response },
          'QQ send API accepted message',
        );
        msgSeq += 1;
      }

      this.nextMessageSeq = msgSeq;
      logger.info({ jid, length: text.length }, 'QQ message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send QQ message');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping || !jid.startsWith('qq:c2c:')) return;

    try {
      const accessToken = await this.getAccessToken();
      const openid = jid.replace(/^qq:c2c:/, '');
      await this.apiRequest(
        accessToken,
        'POST',
        `/v2/users/${openid}/messages`,
        {
          msg_type: 6,
          input_notify: {
            input_type: 1,
            input_second: 60,
          },
          msg_seq: 1,
        },
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send QQ typing indicator');
    }
  }

  private async openGateway(): Promise<void> {
    const accessToken = await this.getAccessToken();
    const gateway = await this.apiRequest(accessToken, 'GET', '/gateway');
    const url = typeof gateway.url === 'string' ? gateway.url : '';
    if (!url) {
      throw new Error(
        `QQ gateway response missing url: ${JSON.stringify(gateway)}`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      const finishResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const fail = (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      };

      ws.on('message', (raw) => {
        try {
          const payload = JSON.parse(raw.toString()) as QQGatewayPayload;
          if (typeof payload.s === 'number') this.lastSeq = payload.s;
          this.handleGatewayPayload(payload, accessToken, finishResolve).catch(
            (err) => {
              logger.error({ err }, 'QQ payload handling failed');
            },
          );
        } catch (err) {
          logger.error({ err }, 'Failed to parse QQ gateway payload');
        }
      });

      ws.on('close', () => {
        this.connected = false;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.ws = null;
        if (!this.shuttingDown) this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'QQ gateway error');
        fail(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async handleGatewayPayload(
    payload: QQGatewayPayload,
    accessToken: string,
    onReady: () => void,
  ): Promise<void> {
    switch (payload.op) {
      case 10: {
        const hello = payload.d as { heartbeat_interval: number };
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
          }
        }, hello.heartbeat_interval);

        this.ws?.send(
          JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${accessToken}`,
              intents: INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
              shard: [0, 1],
            },
          }),
        );
        break;
      }
      case 0: {
        if (payload.t === 'READY') {
          this.connected = true;
          this.reconnectAttempts = 0;
          logger.info(
            {
              appId: this.appId,
              platformTokenConfigured: !!this.platformToken,
            },
            'QQ channel connected',
          );
          onReady();
          return;
        }

        if (payload.t === 'C2C_MESSAGE_CREATE') {
          this.handleC2CMessage(payload.d as QQMessageEvent);
        } else if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleGroupMessage(payload.d as QQMessageEvent);
        }
        break;
      }
      case 7:
        if (!this.shuttingDown) this.scheduleReconnect();
        break;
      case 9:
        this.tokenCache = null;
        if (!this.shuttingDown) this.scheduleReconnect();
        break;
      default:
        break;
    }
  }

  private handleC2CMessage(event: QQMessageEvent): void {
    const sender = event.author.user_openid || event.author.id || '';
    if (!sender) return;

    const chatJid = `qq:c2c:${sender}`;
    const timestamp = this.normalizeTimestamp(event.timestamp);
    const content = this.normalizeInboundText(event.content);
    const senderName = event.author.username || sender;

    this.lastInboundMessageId.set(chatJid, event.id);
    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'qq', false);

    if (!this.opts.registeredGroups()[chatJid]) return;

    this.opts.onMessage(chatJid, {
      id: event.id,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private handleGroupMessage(event: QQMessageEvent): void {
    const sender = event.author.member_openid || event.author.id || '';
    if (!sender || !event.group_openid) return;

    const chatJid = `qq:group:${event.group_openid}`;
    const timestamp = this.normalizeTimestamp(event.timestamp);
    const senderName = event.author.username || sender;
    let content = this.normalizeInboundText(event.content);

    this.lastInboundMessageId.set(chatJid, event.id);

    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`.trim();
    }

    this.opts.onChatMetadata(chatJid, timestamp, chatJid, 'qq', true);

    if (!this.opts.registeredGroups()[chatJid]) return;

    this.opts.onMessage(chatJid, {
      id: event.id,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private normalizeInboundText(text: string): string {
    const strippedMentions = text.replace(/<@!?.+?>/g, '').trim();
    return strippedMentions || '[Empty message]';
  }

  private normalizeTimestamp(timestamp: string): string {
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime())
      ? new Date().toISOString()
      : parsed.toISOString();
  }

  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0 || splitAt < maxLength / 2) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;

    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)
      ];
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openGateway().catch((err) => {
        logger.error({ err }, 'QQ reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async getAccessToken(): Promise<string> {
    if (
      this.tokenCache &&
      Date.now() < this.tokenCache.expiresAt - 5 * 60 * 1000
    ) {
      return this.tokenCache.token;
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    if (!response.ok || !body.access_token) {
      throw new Error(
        `QQ access token request failed: ${JSON.stringify(body)}`,
      );
    }

    this.tokenCache = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in || 7200) * 1000,
    };
    return body.access_token;
  }

  private async apiRequest(
    accessToken: string,
    method: string,
    pathname: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const response = await fetch(`${API_BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    let parsed: Record<string, any> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, any>;
      } catch {
        parsed = { raw };
      }
    }

    if (!response.ok) {
      throw new Error(
        `QQ API ${method} ${pathname} failed: ${JSON.stringify(parsed)}`,
      );
    }

    return parsed;
  }
}

registerChannel('qq', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'QQ_BOT_APPID',
    'QQ_BOT_SECRET',
    'QQ_BOT_TOKEN',
  ]);
  const appId = process.env.QQ_BOT_APPID || envVars.QQ_BOT_APPID || '';
  const secret = process.env.QQ_BOT_SECRET || envVars.QQ_BOT_SECRET || '';
  const platformToken =
    process.env.QQ_BOT_TOKEN || envVars.QQ_BOT_TOKEN || undefined;

  if (!appId || !secret) {
    logger.warn('QQ: QQ_BOT_APPID or QQ_BOT_SECRET not set');
    return null;
  }

  return new QQChannel(appId, secret, platformToken, opts);
});
