import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan } from 'typeorm';
import * as crypto from 'crypto';
import { Otp, OtpStatus } from './entities/otp.entity';
import { CreateOtpDto } from './dto';
import { SessionService } from '../session/session.service';
import { EventsGateway } from '../events/events.gateway';
import { HookManager } from '../../core/hooks';
import { createLogger } from '../../common/services/logger.service';

@Injectable()
export class OtpService implements OnModuleInit {
  private readonly logger = createLogger('OtpService');
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Otp, 'data')
    private readonly otpRepository: Repository<Otp>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly sessionService: SessionService,
    private readonly eventsGateway: EventsGateway,
    private readonly hookManager: HookManager,
  ) {}

  onModuleInit(): void {
    // Register hook to intercept incoming messages for OTP matching
    this.hookManager.register(
      'otp-module',
      'message:received',
      async ctx => {
        const message = ctx.data as {
          from: string;
          body: string;
          isGroup: boolean;
        };

        // Only process direct messages (not group messages)
        if (message.isGroup) {
          return { continue: true, data: ctx.data };
        }

        const handled = await this.handleIncomingMessage(ctx.sessionId as string, message.from, message.body);

        // Let the message continue through the pipeline regardless
        // OTP matching is a side-effect, not a filter
        if (handled) {
          this.logger.log('OTP verified via incoming message', {
            from: message.from,
            action: 'otp_matched',
          });
        }

        return { continue: true, data: ctx.data };
      },
      50, // Higher priority (lower number) to check OTPs before other plugins
    );

    // Start the expiry cleanup cron
    this.startExpiryCron();

    this.logger.log('OTP service initialized with message hook');
  }

  async create(dto: CreateOtpDto): Promise<{
    otp: Otp;
    whatsappLink: string;
  }> {
    // Resolve session by name to get the actual session ID and phone
    const session = await this.sessionService.findByName(dto.sessionId);

    if (!session.phone) {
      throw new BadRequestException(`Session '${dto.sessionId}' is not connected — no phone number available`);
    }

    // Cancel any existing pending OTP for this phone + session
    await this.otpRepository.update(
      { phone: dto.phone, sessionId: session.id, status: OtpStatus.PENDING },
      { status: OtpStatus.CANCELLED },
    );

    const expiresIn = dto.expiresIn ?? 120;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const otp = this.otpRepository.create({
      phone: dto.phone,
      code: dto.code,
      sessionId: session.id,
      callbackUrl: dto.callbackUrl || null,
      callbackSecret: dto.callbackSecret || null,
      status: OtpStatus.PENDING,
      expiresAt,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(otp);
    });

    // Build the wa.me link using the session's phone number (strip the + prefix)
    const waNumber = session.phone.replace(/\D/g, '');
    const whatsappLink = `https://wa.me/${waNumber}?text=${encodeURIComponent(dto.code)}`;

    this.logger.log(`OTP created for ${dto.phone}`, {
      otpId: saved.id,
      sessionId: session.id,
      expiresAt: expiresAt.toISOString(),
      action: 'otp_created',
    });

    return { otp: saved, whatsappLink };
  }

  async findOne(id: string): Promise<Otp> {
    const otp = await this.otpRepository.findOne({ where: { id } });
    if (!otp) {
      throw new NotFoundException(`OTP with id '${id}' not found`);
    }
    return otp;
  }

  async cancel(id: string): Promise<void> {
    const otp = await this.findOne(id);
    if (otp.status !== OtpStatus.PENDING) {
      throw new BadRequestException(`OTP is already ${otp.status}`);
    }

    await this.otpRepository.update(id, { status: OtpStatus.CANCELLED });

    this.logger.log(`OTP cancelled: ${id}`, {
      otpId: id,
      action: 'otp_cancelled',
    });
  }

  /**
   * Match an incoming WhatsApp message against pending OTPs.
   * Returns true if a match was found and verified.
   */
  async handleIncomingMessage(sessionId: string, from: string, body: string): Promise<boolean> {
    // Normalize the sender: "628123456789@c.us" → "+628123456789"
    const senderPhone = this.normalizeWhatsAppId(from);
    if (!senderPhone) return false;

    const code = body.trim();

    // Find a pending OTP matching this phone + code + session
    const otp = await this.otpRepository.findOne({
      where: {
        phone: senderPhone,
        code,
        sessionId,
        status: OtpStatus.PENDING,
      },
    });

    if (!otp) return false;

    // Check if expired
    if (new Date() > otp.expiresAt) {
      await this.otpRepository.update(otp.id, { status: OtpStatus.EXPIRED });
      return false;
    }

    // Mark as verified
    const verifiedAt = new Date();
    await this.otpRepository.update(otp.id, {
      status: OtpStatus.VERIFIED,
      verifiedAt,
    });

    const verifiedOtp = { ...otp, status: OtpStatus.VERIFIED, verifiedAt };

    // Notify via WebSocket
    this.eventsGateway.emitEvent(sessionId, 'otp.verified', {
      id: otp.id,
      phone: otp.phone,
      verified: true,
      verifiedAt: verifiedAt.toISOString(),
    });

    // Send callback if configured
    if (otp.callbackUrl) {
      void this.sendCallback(verifiedOtp, true);
    }

    this.logger.log(`OTP verified for ${otp.phone}`, {
      otpId: otp.id,
      sessionId,
      action: 'otp_verified',
    });

    return true;
  }

  /**
   * Send verification result to the client's callback URL.
   */
  private async sendCallback(otp: Otp, verified: boolean, reason?: string): Promise<void> {
    if (!otp.callbackUrl) return;

    const payload = {
      id: otp.id,
      phone: otp.phone,
      verified,
      ...(verified && otp.verifiedAt ? { verifiedAt: otp.verifiedAt.toISOString() } : {}),
      ...(!verified && reason ? { reason } : {}),
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'OpenWA-OTP/1.0.0',
    };

    if (otp.callbackSecret) {
      const hmac = crypto.createHmac('sha256', otp.callbackSecret);
      hmac.update(body);
      headers['X-OTP-Signature'] = `sha256=${hmac.digest('hex')}`;
    }

    // Retry logic: 3 attempts with exponential backoff (5s, 15s, 45s)
    const delays = [0, 5000, 15000, 45000];

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await this.delay(delays[attempt]);
      }

      try {
        const response = await fetch(otp.callbackUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          this.logger.debug(`OTP callback delivered for ${otp.id}`, {
            otpId: otp.id,
            attempt: attempt + 1,
            action: 'otp_callback_delivered',
          });
          return;
        }

        this.logger.warn(`OTP callback failed (attempt ${attempt + 1}/4): HTTP ${response.status}`, {
          otpId: otp.id,
          statusCode: response.status,
          action: 'otp_callback_failed',
        });
      } catch (error) {
        this.logger.warn(
          `OTP callback error (attempt ${attempt + 1}/4): ${error instanceof Error ? error.message : String(error)}`,
          {
            otpId: otp.id,
            action: 'otp_callback_error',
          },
        );
      }
    }

    this.logger.error(`OTP callback permanently failed for ${otp.id}`, undefined, {
      otpId: otp.id,
      callbackUrl: otp.callbackUrl,
      action: 'otp_callback_permanently_failed',
    });
  }

  /**
   * Expire OTPs past their expiresAt timestamp.
   * Runs every 60 seconds.
   */
  private async expireOldOtps(): Promise<void> {
    const now = new Date();
    const expired = await this.otpRepository.find({
      where: {
        status: OtpStatus.PENDING,
        expiresAt: LessThan(now),
      },
    });

    if (expired.length === 0) return;

    await this.otpRepository.update(
      expired.map(o => o.id),
      { status: OtpStatus.EXPIRED },
    );

    this.logger.log(`Expired ${expired.length} OTP(s)`, {
      count: expired.length,
      action: 'otp_expiry_cleanup',
    });

    // Send expiry callbacks and WebSocket notifications
    for (const otp of expired) {
      this.eventsGateway.emitEvent(otp.sessionId, 'otp.expired', {
        id: otp.id,
        phone: otp.phone,
        verified: false,
      });

      if (otp.callbackUrl) {
        void this.sendCallback({ ...otp, status: OtpStatus.EXPIRED }, false, 'expired');
      }
    }
  }

  private startExpiryCron(): void {
    this.expiryTimer = setInterval(() => {
      void this.expireOldOtps();
    }, 60_000);
  }

  onModuleDestroy(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * Convert WhatsApp JID "628123456789@c.us" to E.164 "+628123456789"
   */
  private normalizeWhatsAppId(jid: string): string | null {
    const match = jid.match(/^(\d+)@/);
    if (!match) return null;
    return `+${match[1]}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
