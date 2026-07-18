import { Controller, Get, Post, Delete, Patch, Param, Body, Query, HttpCode, HttpStatus, Res, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { SessionService } from './session.service';
import { CreateSessionDto, SessionResponseDto, QRCodeResponseDto } from './dto';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { RequireRole, Public } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('sessions')
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  // Transform entity to DTO with lastActive field name
  private transformSession(session: Session): SessionResponseDto {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      phone: session.phone,
      pushName: session.pushName,
      connectedAt: session.connectedAt,
      lastActive: session.lastActiveAt,
      config: session.config,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a new WhatsApp session' })
  @ApiResponse({
    status: 201,
    description: 'Session created',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 409, description: 'Session name already exists' })
  async create(@Body() dto: CreateSessionDto): Promise<Session> {
    const session = await this.sessionService.create(dto);
    await this.auditService.logInfo(AuditAction.SESSION_CREATED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return session;
  }

  @Get()
  @ApiOperation({ summary: 'List all sessions' })
  @ApiResponse({
    status: 200,
    description: 'List of sessions',
    type: [SessionResponseDto],
  })
  async findAll(): Promise<SessionResponseDto[]> {
    const sessions = await this.sessionService.findAll();
    return sessions.map(s => this.transformSession(s));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get session by ID' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session details',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async findOne(@Param('id') id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.findOne(id);
    return this.transformSession(session);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 204, description: 'Session deleted' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async delete(@Param('id') id: string): Promise<void> {
    const session = await this.sessionService.findOne(id);
    await this.sessionService.delete(id);
    await this.auditService.logInfo(AuditAction.SESSION_DELETED, {
      sessionId: id,
      sessionName: session.name,
    });
  }

  @Patch(':id/config')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update session configuration' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session config updated',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async updateConfig(
    @Param('id') id: string,
    @Body() config: Record<string, unknown>,
  ): Promise<SessionResponseDto> {
    const session = await this.sessionService.updateConfig(id, config);
    await this.auditService.logInfo(AuditAction.SESSION_UPDATED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/start')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Start a session and initialize WhatsApp connection',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session started',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Session already started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async start(@Param('id') id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.start(id);
    await this.auditService.logInfo(AuditAction.SESSION_STARTED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/stop')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Stop a session and disconnect WhatsApp' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session stopped',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async stop(@Param('id') id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.stop(id);
    await this.auditService.logInfo(AuditAction.SESSION_STOPPED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Get(':id/qr')
  @ApiOperation({ summary: 'Get QR code for session authentication' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'QR code data',
    type: QRCodeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'QR code not ready or session already authenticated',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getQRCode(@Param('id') id: string): Promise<QRCodeResponseDto> {
    const qrCode = await this.sessionService.getQRCode(id);
    await this.auditService.logInfo(AuditAction.SESSION_QR_GENERATED, {
      sessionId: id,
    });
    return qrCode;
  }

  @Get(':id/groups')
  @ApiOperation({ summary: 'Get all groups for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of groups the session is a member of',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getGroups(@Param('id') id: string): Promise<{ id: string; name: string }[]> {
    return this.sessionService.getGroups(id);
  }

  @Post(':id/qr/share')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Generate a shareable QR code page link' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiQuery({ name: 'ttl', required: false, description: 'Token TTL in minutes (default: 10)' })
  @ApiResponse({
    status: 200,
    description: 'Share token and URL',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async createShareLink(
    @Param('id') id: string,
    @Query('ttl') ttl?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const ttlMinutes = ttl ? parseInt(ttl, 10) : 4320;
    if (isNaN(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 4320) {
      throw new BadRequestException('TTL must be between 1 and 4320 minutes (3 days)');
    }
    const result = await this.sessionService.createShareToken(id, ttlMinutes);
    await this.auditService.logInfo(AuditAction.SESSION_QR_GENERATED, {
      sessionId: id,
    });
    return result;
  }

  @Get(':id/qr/page')
  @Public()
  @ApiOperation({ summary: 'Public QR code page for scanning (requires share token)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiQuery({ name: 'token', description: 'Share token from POST /sessions/:id/qr/share' })
  @ApiResponse({ status: 200, description: 'HTML page with QR code' })
  @ApiResponse({ status: 401, description: 'Invalid or expired token' })
  async getQRPage(
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!token) {
      throw new UnauthorizedException('Share token is required');
    }
    const sessionId = this.sessionService.validateShareToken(token);
    if (!sessionId || sessionId !== id) {
      throw new UnauthorizedException('Invalid or expired share token');
    }

    const session = await this.sessionService.findOne(id);

    res.setHeader('Content-Type', 'text/html');
    res.send(this.renderQRPage(session.name, id, token));
  }

  @Get(':id/qr/data')
  @Public()
  @ApiOperation({ summary: 'Public QR code data endpoint (requires share token)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiQuery({ name: 'token', description: 'Share token' })
  @ApiResponse({ status: 200, description: 'QR code data' })
  async getQRData(
    @Param('id') id: string,
    @Query('token') token: string,
  ): Promise<{ qrCode: string | null; status: SessionStatus; sessionName: string }> {
    if (!token) {
      throw new UnauthorizedException('Share token is required');
    }
    const sessionId = this.sessionService.validateShareToken(token);
    if (!sessionId || sessionId !== id) {
      throw new UnauthorizedException('Invalid or expired share token');
    }

    const session = await this.sessionService.findOne(id);
    let qrCode: string | null = null;

    try {
      const qr = await this.sessionService.getQRCode(id);
      qrCode = qr.qrCode;
    } catch {
      // QR not available — session may be already connected or not started
    }

    return { qrCode, status: session.status, sessionName: session.name };
  }

  private renderQRPage(sessionName: string, sessionId: string, token: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scan QR - ${sessionName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 420px;
      width: 100%;
    }
    .card {
      background: #1e293b;
      border-radius: 16px;
      padding: 2rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    h1 {
      font-size: 1.25rem;
      margin-bottom: 0.25rem;
      color: #f1f5f9;
    }
    .session-name {
      font-size: 0.875rem;
      color: #94a3b8;
      margin-bottom: 1.5rem;
    }
    .qr-container {
      background: white;
      border-radius: 12px;
      padding: 1rem;
      display: inline-block;
      margin-bottom: 1.5rem;
    }
    .qr-container img {
      display: block;
      max-width: 256px;
      width: 100%;
      height: auto;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 1rem;
    }
    .status.qr_ready { background: #1e3a5f; color: #60a5fa; }
    .status.ready { background: #14532d; color: #4ade80; }
    .status.initializing, .status.authenticating { background: #422006; color: #fbbf24; }
    .status.disconnected, .status.failed { background: #450a0a; color: #f87171; }
    .status.created { background: #1e293b; color: #94a3b8; }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .status.qr_ready .status-dot, .status.initializing .status-dot, .status.authenticating .status-dot {
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .instructions {
      text-align: left;
      margin-top: 1.5rem;
      font-size: 0.8125rem;
      color: #94a3b8;
      line-height: 1.6;
    }
    .instructions ol { padding-left: 1.25rem; }
    .instructions li { margin-bottom: 0.5rem; }
    .spinner {
      width: 48px; height: 48px;
      border: 4px solid #334155;
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 2rem auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .message { color: #94a3b8; font-size: 0.875rem; }
    .success-icon {
      font-size: 3rem;
      margin: 1rem 0;
    }
    .expired { color: #f87171; }
    .refresh-note {
      font-size: 0.75rem;
      color: #64748b;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>WhatsApp QR Code</h1>
      <p class="session-name" id="session-name">${sessionName}</p>
      <div id="content">
        <div class="spinner"></div>
        <p class="message">Loading...</p>
      </div>
      <div class="instructions" id="instructions" style="display:none">
        <ol>
          <li>Open <strong>WhatsApp</strong> on your phone</li>
          <li>Go to <strong>Settings &gt; Linked Devices</strong></li>
          <li>Tap <strong>Link a Device</strong> and scan the code</li>
        </ol>
      </div>
    </div>
  </div>
  <script>
    const sessionId = "${sessionId}";
    const token = "${token}";
    const contentEl = document.getElementById('content');
    const instructionsEl = document.getElementById('instructions');
    let connected = false;

    async function fetchQR() {
      if (connected) return;
      try {
        const res = await fetch(\`/api/sessions/\${sessionId}/qr/data?token=\${token}\`);
        if (res.status === 401) {
          contentEl.innerHTML = '<p class="message expired">Link has expired. Please request a new one.</p>';
          instructionsEl.style.display = 'none';
          return;
        }
        const data = await res.json();

        if (data.status === 'ready') {
          connected = true;
          contentEl.innerHTML =
            '<div class="success-icon">&#x2705;</div>' +
            '<div class="status ready"><span class="status-dot"></span> Connected</div>' +
            '<p class="message">Session is now connected!</p>';
          instructionsEl.style.display = 'none';
          return;
        }

        if (data.qrCode) {
          contentEl.innerHTML =
            '<div class="status ' + data.status + '"><span class="status-dot"></span> ' + formatStatus(data.status) + '</div>' +
            '<div class="qr-container"><img src="' + data.qrCode + '" alt="QR Code" /></div>' +
            '<p class="refresh-note">QR code refreshes automatically</p>';
          instructionsEl.style.display = 'block';
        } else {
          contentEl.innerHTML =
            '<div class="status ' + data.status + '"><span class="status-dot"></span> ' + formatStatus(data.status) + '</div>' +
            '<div class="spinner"></div>' +
            '<p class="message">Waiting for QR code...</p>';
          instructionsEl.style.display = 'none';
        }
      } catch {
        contentEl.innerHTML = '<div class="spinner"></div><p class="message">Reconnecting...</p>';
      }
    }

    function formatStatus(s) {
      const map = { qr_ready: 'Scan QR Code', initializing: 'Initializing...', authenticating: 'Authenticating...', ready: 'Connected', disconnected: 'Disconnected', failed: 'Failed', created: 'Created' };
      return map[s] || s;
    }

    fetchQR();
    setInterval(fetchQR, 3000);
  </script>
</body>
</html>`;
  }

  @Get('stats/overview')
  @ApiOperation({
    summary: 'Get session statistics for multi-session monitoring',
  })
  @ApiResponse({
    status: 200,
    description: 'Session statistics including counts and memory usage',
  })
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    return this.sessionService.getStats();
  }
}
