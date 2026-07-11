import { EventEmitter } from 'events';
import * as qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

export interface BaileysConfig {
  sessionId: string;
  sessionDataPath: string;
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

// Silent logger compatible with Baileys/pino interface
const silentLogger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

export class BaileysAdapter extends EventEmitter implements IWhatsAppEngine {
  private readonly logger = createLogger('BaileysAdapter');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sock: any = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private saveCreds: (() => Promise<void>) | null = null;
  private shouldReconnect = false;
  private contacts: Map<string, Contact> = new Map();
  // LID → phone number mapping (e.g. "169419766538483" → "201119915593")
  private lidToPhone: Map<string, string> = new Map();

  constructor(private readonly config: BaileysConfig) {
    super();
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.shouldReconnect = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Dynamic import to handle ESM module
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const baileys = (await import('@whiskeysockets/baileys')) as any;
      const makeWASocket = baileys.default ?? baileys.makeWASocket;
      const {
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason,
        isJidGroup,
        downloadMediaMessage,
        getContentType,
      } = baileys;

      const sessionPath = path.resolve(this.config.sessionDataPath, this.config.sessionId);
      fs.mkdirSync(sessionPath, { recursive: true });

      // Load persisted LID→phone map from previous sessions
      this.loadLidMap();

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      this.saveCreds = saveCreds;

      let version: number[];
      try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
      } catch {
        // Fallback version if fetch fails
        version = [2, 3000, 1015901307];
      }

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: silentLogger,
        browser: ['OpenWA', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
      });

      // Persist auth credentials on update
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.sock.ev.on('creds.update', saveCreds);

      // Handle connection state changes
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.sock.ev.on('connection.update', async (update: Record<string, unknown>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCode = await qrcode.toDataURL(qr as string);
            this.setStatus(EngineStatus.QR_READY);
            this.callbacks.onQRCode?.(this.qrCode);
          } catch (error) {
            this.logger.error('Error generating QR code', String(error));
          }
        }

        if (connection === 'connecting') {
          this.setStatus(EngineStatus.AUTHENTICATING);
        }

        if (connection === 'open') {
          this.qrCode = null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const user = this.sock?.user as any;
          this.phoneNumber = user?.id ? String(user.id).split(':')[0].split('@')[0] : null;
          this.pushName = user?.name ? String(user.name) : null;
          this.setStatus(EngineStatus.READY);
          this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
          this.logger.log(`Baileys session ready: ${this.phoneNumber}`);
        }

        if (connection === 'close') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const statusCode = (lastDisconnect as any)?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          this.logger.log(`Connection closed. Code: ${statusCode}, LoggedOut: ${loggedOut}`);
          this.setStatus(EngineStatus.DISCONNECTED);
          this.callbacks.onDisconnected?.(String(statusCode ?? 'unknown'));

          if (!loggedOut && this.shouldReconnect) {
            this.logger.log('Scheduling reconnect in 3s...');
            setTimeout(() => {
              if (this.shouldReconnect) {
                this.connect().catch(err => this.logger.error('Reconnect failed', String(err)));
              }
            }, 3000);
          }
        }
      });

      // Handle incoming messages
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.sock.ev.on('messages.upsert', async (m: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages = m.messages as any[];
        const type = m.type as string;

        this.logger.log(`messages.upsert: type=${type} count=${messages?.length ?? 0}`);

        if (type !== 'notify') return;

        for (const msg of messages) {
          if (!msg.message || msg.key?.fromMe) {
            this.logger.log(`Skipping message: hasMessage=${!!msg.message} fromMe=${msg.key?.fromMe} jid=${msg.key?.remoteJid}`);
            continue;
          }
          this.logger.log(`Processing message: remoteJid=${msg.key?.remoteJid} participant=${msg.key?.participant} pushName=${msg.pushName} verifiedBizName=${msg.verifiedBizName} keys=${Object.keys(msg).join(',')}`);

          try {
            const parsed = await this.parseMessage(msg, { isJidGroup, downloadMediaMessage, getContentType });
            if (parsed) {
              this.callbacks.onMessage?.(parsed);
            }
          } catch (error) {
            this.logger.error('Error processing incoming message', String(error));
          }
        }
      });

      // Track LID → phone number mapping from contact events
      this.sock.ev.on('messaging-history.set', (data: { contacts: { id: string; lid?: string; jid?: string }[] }) => {
        if (data.contacts?.length) {
          this.updateLidMap(data.contacts);
        }
      });
      this.sock.ev.on('contacts.upsert', (contacts: { id: string; lid?: string; jid?: string }[]) => {
        this.updateLidMap(contacts);
      });
      this.sock.ev.on('contacts.update', (contacts: { id: string; lid?: string; jid?: string }[]) => {
        this.updateLidMap(contacts);
      });

    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseMessage(msg: any, helpers: any): Promise<IncomingMessage | null> {
    const { isJidGroup, downloadMediaMessage, getContentType } = helpers;
    const key = msg.key;
    const chatId = String(key.remoteJid ?? '');
    if (!chatId) return null;

    const contentType = getContentType(msg.message) as string | undefined;
    if (!contentType) return null;

    const content = msg.message[contentType];
    let body = '';
    let type = 'chat';

    switch (contentType) {
      case 'conversation':
        body = String(msg.message.conversation ?? '');
        type = 'chat';
        break;
      case 'extendedTextMessage':
        body = String(content?.text ?? '');
        type = 'chat';
        break;
      case 'imageMessage':
        body = String(content?.caption ?? '');
        type = 'image';
        break;
      case 'videoMessage':
        body = String(content?.caption ?? '');
        type = 'video';
        break;
      case 'audioMessage':
        body = '';
        type = 'audio';
        break;
      case 'documentMessage':
        body = String(content?.fileName ?? '');
        type = 'document';
        break;
      case 'stickerMessage':
        body = '';
        type = 'sticker';
        break;
      case 'locationMessage':
        body = String(content?.name ?? '');
        type = 'location';
        break;
      default:
        body = '';
        type = contentType;
    }

    const from = String(key.fromMe ? (this.sock?.user?.id ?? '') : chatId);
    const to = String(key.fromMe ? chatId : (this.sock?.user?.id ?? ''));

    const incomingMessage: IncomingMessage = {
      id: String(key.id ?? ''),
      from: this.jidToNumber(from),
      to: this.jidToNumber(to),
      chatId,
      body,
      type,
      timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
      fromMe: Boolean(key.fromMe),
      isGroup: Boolean(isJidGroup(chatId)),
    };

    // Download media
    const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    if (mediaTypes.includes(contentType)) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer | null;
        if (buffer) {
          incomingMessage.media = {
            mimetype: String(content?.mimetype ?? 'application/octet-stream'),
            filename: content?.fileName ? String(content.fileName) : undefined,
            data: buffer.toString('base64'),
          };
        }
      } catch (error) {
        this.logger.warn('Could not download media', String(error));
      }
    }

    // Quoted message
    const contextInfo = content?.contextInfo;
    if (contextInfo?.stanzaId && contextInfo?.quotedMessage) {
      const quotedType = getContentType(contextInfo.quotedMessage) as string | undefined;
      const quotedContent = quotedType ? contextInfo.quotedMessage[quotedType] : null;
      incomingMessage.quotedMessage = {
        id: String(contextInfo.stanzaId),
        body: String(
          quotedContent?.text ?? quotedContent?.caption ?? quotedContent?.conversation ?? '',
        ),
      };
    }

    return incomingMessage;
  }

  private jidToNumber(jid: string): string {
    if (!jid) return '';
    const number = jid.split('@')[0].split(':')[0];
    // If this is a LID, resolve to actual phone number
    if (jid.endsWith('@lid')) {
      const resolved = this.lidToPhone.get(number);
      if (resolved) {
        return resolved;
      }
      this.logger.warn(`Could not resolve LID ${number} to phone number`);
    }
    return number;
  }

  private updateLidMap(contacts: { id: string; lid?: string; jid?: string }[]): void {
    let added = 0;
    for (const contact of contacts) {
      const lid = contact.lid ? contact.lid.split('@')[0].split(':')[0] : null;
      const jid = contact.jid ? contact.jid.split('@')[0].split(':')[0] : null;

      // Map LID → phone from contact.lid + contact.jid
      if (lid && jid) {
        if (!this.lidToPhone.has(lid)) added++;
        this.lidToPhone.set(lid, jid);
      }

      // Also handle case where contact.id is LID and contact.jid has the phone
      if (contact.id?.endsWith('@lid') && jid) {
        const idNum = contact.id.split('@')[0].split(':')[0];
        if (!this.lidToPhone.has(idNum)) added++;
        this.lidToPhone.set(idNum, jid);
      }

      // Or contact.id is phone and contact.lid has the LID
      if (contact.id?.endsWith('@s.whatsapp.net') && lid) {
        const phone = contact.id.split('@')[0].split(':')[0];
        if (!this.lidToPhone.has(lid)) added++;
        this.lidToPhone.set(lid, phone);
      }
    }

    if (added > 0) {
      this.logger.log(`LID map updated: +${added} new entries (total: ${this.lidToPhone.size})`);
      this.persistLidMap();
    }
  }

  private get lidMapPath(): string {
    return path.resolve(this.config.sessionDataPath, this.config.sessionId, 'lid-map.json');
  }

  private persistLidMap(): void {
    try {
      const data = Object.fromEntries(this.lidToPhone);
      fs.writeFileSync(this.lidMapPath, JSON.stringify(data));
    } catch (error) {
      this.logger.warn('Failed to persist LID map', String(error));
    }
  }

  private loadLidMap(): void {
    try {
      if (fs.existsSync(this.lidMapPath)) {
        const data = JSON.parse(fs.readFileSync(this.lidMapPath, 'utf-8'));
        for (const [lid, phone] of Object.entries(data)) {
          this.lidToPhone.set(lid, phone as string);
        }
        this.logger.log(`LID map loaded: ${this.lidToPhone.size} entries from disk`);
      }
    } catch (error) {
      this.logger.warn('Failed to load LID map', String(error));
    }
  }

  private normalizeJid(jid: string): string {
    if (jid.includes('@')) return jid;
    return `${jid}@s.whatsapp.net`;
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new Error('WhatsApp client is not ready');
    }
  }

  // ========== Lifecycle ==========

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (error) {
        this.logger.warn('Socket end failed', String(error));
      }
      this.sock = null;
    }
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  async logout(): Promise<void> {
    this.shouldReconnect = false;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (error) {
        this.logger.warn('Logout failed, forcing close', String(error));
        try {
          this.sock.end(undefined);
        } catch { /* ignore */ }
      }
      this.sock = null;
    }
    // Remove session files so next start requires QR scan
    const sessionPath = path.resolve(this.config.sessionDataPath, this.config.sessionId);
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('Failed to remove session files', String(error));
    }
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  async destroy(): Promise<void> {
    this.shouldReconnect = false;
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch { /* ignore */ }
      this.sock = null;
    }
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  // ========== Status ==========

  getStatus(): EngineStatus { return this.status; }
  getQRCode(): string | null { return this.qrCode; }
  getPhoneNumber(): string | null { return this.phoneNumber; }
  getPushName(): string | null { return this.pushName; }

  // ========== Messaging ==========

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, { text });
    return this.toResult(result);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    const buffer = await this.toBuffer(media);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, {
      image: buffer,
      caption: media.caption,
      mimetype: media.mimetype,
    });
    return this.toResult(result);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    const buffer = await this.toBuffer(media);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, {
      video: buffer,
      caption: media.caption,
      mimetype: media.mimetype,
    });
    return this.toResult(result);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    const buffer = await this.toBuffer(media);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, {
      audio: buffer,
      mimetype: media.mimetype ?? 'audio/mpeg',
      ptt: false,
    });
    return this.toResult(result);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    const buffer = await this.toBuffer(media);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, {
      document: buffer,
      mimetype: media.mimetype,
      fileName: media.filename ?? 'document',
    });
    return this.toResult(result);
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description,
        address: location.address,
      },
    });
    return this.toResult(result);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, {
      contacts: {
        displayName: contact.name,
        contacts: [{ vcard }],
      },
    });
    return this.toResult(result);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    const buffer = await this.toBuffer(media);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, { sticker: buffer });
    return this.toResult(result);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(
      jid,
      { text },
      { quoted: { key: { id: quotedMsgId, remoteJid: jid } } },
    );
    return this.toResult(result);
  }

  async forwardMessage(_fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    // Baileys forward requires the original message object from a store.
    // Without a message store, we fall back to a text reference.
    this.logger.warn('forwardMessage has limited support without message store in Baileys');
    const jid = this.normalizeJid(toChatId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.sendMessage(jid, { text: `[Forwarded: ${messageId}]` });
    return this.toResult(result);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    await this.sock.sendMessage(jid, {
      react: { text: emoji, key: { id: messageId, remoteJid: jid } },
    });
  }

  async getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    // Reactions require a message store to track — not available without one
    this.logger.warn('getMessageReactions requires a message store (not configured)');
    return [];
  }

  // ========== Contacts ==========

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    // Contacts accumulate from incoming messages; Baileys has no dedicated contacts list API
    return Array.from(this.contacts.values());
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    const jid = this.normalizeJid(contactId);
    return this.contacts.get(jid) ?? null;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const clean = number.replace(/\D/g, '');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.onWhatsApp(clean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Array.isArray(result) && result.length > 0 && Boolean((result[0] as any).exists);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const jid = this.normalizeJid(contactId);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const url = await this.sock.profilePictureUrl(jid, 'image');
      return url ? String(url) : null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}`, String(error));
      return null;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const jid = this.normalizeJid(contactId);
    await this.sock.updateBlockStatus(jid, 'block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const jid = this.normalizeJid(contactId);
    await this.sock.updateBlockStatus(jid, 'unblock');
  }

  // ========== Groups ==========

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const groups = await this.sock.groupFetchAllParticipating();
    const myJid = String(this.sock?.user?.id ?? '');
    return Object.values(groups).map((g: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const group = g as any;
      return {
        id: String(group.id),
        name: String(group.subject ?? ''),
        participantsCount: Array.isArray(group.participants) ? group.participants.length : undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isAdmin: Array.isArray(group.participants) && group.participants.some((p: any) =>
          String(p.id) === myJid && (p.admin === 'admin' || p.admin === 'superadmin'),
        ),
      };
    });
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const metadata = await this.sock.groupMetadata(groupId);
      if (!metadata) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const participants: GroupParticipant[] = (metadata.participants ?? []).map((p: any) => ({
        id: String(p.id),
        number: String(p.id).split('@')[0],
        name: p.name ? String(p.name) : undefined,
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        isSuperAdmin: p.admin === 'superadmin',
      }));

      return {
        id: String(metadata.id),
        name: String(metadata.subject ?? ''),
        description: metadata.desc ? String(metadata.desc) : undefined,
        owner: metadata.owner ? String(metadata.owner) : undefined,
        createdAt: metadata.creation ? Number(metadata.creation) : undefined,
        participants,
        isReadOnly: Boolean(metadata.announce),
        isAnnounce: Boolean(metadata.announce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group info: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    const jids = participants.map(p => this.normalizeJid(p));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.sock.groupCreate(name, jids);
    return {
      id: String(result.id),
      name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const jids = participants.map(p => this.normalizeJid(p));
    await this.sock.groupParticipantsUpdate(groupId, jids, 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const jids = participants.map(p => this.normalizeJid(p));
    await this.sock.groupParticipantsUpdate(groupId, jids, 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const jids = participants.map(p => this.normalizeJid(p));
    await this.sock.groupParticipantsUpdate(groupId, jids, 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const jids = participants.map(p => this.normalizeJid(p));
    await this.sock.groupParticipantsUpdate(groupId, jids, 'demote');
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    await this.sock.groupLeave(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    await this.sock.groupUpdateSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    await this.sock.groupUpdateDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const code = await this.sock.groupInviteCode(groupId) as string;
    return code;
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const code = await this.sock.groupRevokeInvite(groupId) as string | null;
    return code ?? '';
  }

  async deleteMessage(chatId: string, messageId: string, _forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const jid = this.normalizeJid(chatId);
    await this.sock.sendMessage(jid, {
      delete: { id: messageId, remoteJid: jid, fromMe: true },
    });
  }

  // ========== Unsupported: Labels (WhatsApp Business only) ==========
  // eslint-disable-next-line @typescript-eslint/require-await
  async getLabels(): Promise<Label[]> {
    this.logger.warn('Labels are not supported in the Baileys engine');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getLabelById(_labelId: string): Promise<Label | null> {
    this.logger.warn('Labels are not supported in the Baileys engine');
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChatLabels(_chatId: string): Promise<Label[]> {
    this.logger.warn('Labels are not supported in the Baileys engine');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addLabelToChat(_chatId: string, _labelId: string): Promise<void> {
    throw new Error('Labels are not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async removeLabelFromChat(_chatId: string, _labelId: string): Promise<void> {
    throw new Error('Labels are not supported in the Baileys engine');
  }

  // ========== Unsupported: Channels ==========
  // eslint-disable-next-line @typescript-eslint/require-await
  async getSubscribedChannels(): Promise<Channel[]> {
    this.logger.warn('Channels are not supported in the Baileys engine');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChannelById(_channelId: string): Promise<Channel | null> {
    this.logger.warn('Channels are not supported in the Baileys engine');
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribeToChannel(_inviteCode: string): Promise<Channel> {
    throw new Error('Channels are not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async unsubscribeFromChannel(_channelId: string): Promise<void> {
    throw new Error('Channels are not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    this.logger.warn('Channels are not supported in the Baileys engine');
    return [];
  }

  // ========== Unsupported: Status/Stories ==========
  // eslint-disable-next-line @typescript-eslint/require-await
  async getContactStatuses(): Promise<Status[]> {
    this.logger.warn('Status/Stories are not supported in the Baileys engine');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.logger.warn('Status/Stories are not supported in the Baileys engine');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    throw new Error('Status posting is not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    throw new Error('Status posting is not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    throw new Error('Status posting is not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteStatus(_statusId: string): Promise<void> {
    throw new Error('Status management is not supported in the Baileys engine');
  }

  // ========== Unsupported: Catalog ==========
  // eslint-disable-next-line @typescript-eslint/require-await
  async getCatalog(): Promise<Catalog | null> {
    this.logger.warn('Catalog is not supported in the Baileys engine');
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.logger.warn('Catalog is not supported in the Baileys engine');
    return { products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getProduct(_productId: string): Promise<Product | null> {
    this.logger.warn('Catalog is not supported in the Baileys engine');
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    throw new Error('Catalog is not supported in the Baileys engine');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    throw new Error('Catalog is not supported in the Baileys engine');
  }

  // ========== Helpers ==========

  private async toBuffer(media: MediaInput): Promise<Buffer> {
    if (Buffer.isBuffer(media.data)) {
      return media.data;
    }
    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        const response = await fetch(media.data);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      return Buffer.from(media.data, 'base64');
    }
    throw new Error('Invalid media data: must be Buffer, base64 string, or URL');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toResult(result: any): MessageResult {
    return {
      id: String(result?.key?.id ?? `msg_${Date.now()}`),
      timestamp: result?.messageTimestamp
        ? Number(result.messageTimestamp)
        : Math.floor(Date.now() / 1000),
    };
  }
}
