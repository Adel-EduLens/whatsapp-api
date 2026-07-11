import { Controller, Get, Post, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { OtpService } from './otp.service';
import { CreateOtpDto, OtpResponseDto } from './dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('otp')
@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Register a new OTP verification' })
  @ApiResponse({
    status: 201,
    description: 'OTP created',
    type: OtpResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or session not connected' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async create(@Body() dto: CreateOtpDto): Promise<OtpResponseDto> {
    const { otp, whatsappLink } = await this.otpService.create(dto);
    return {
      id: otp.id,
      phone: otp.phone,
      status: otp.status,
      expiresAt: otp.expiresAt.toISOString(),
      whatsappLink,
      createdAt: otp.createdAt.toISOString(),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Check status of an OTP verification' })
  @ApiParam({ name: 'id', description: 'OTP ID' })
  @ApiResponse({
    status: 200,
    description: 'OTP details',
    type: OtpResponseDto,
  })
  @ApiResponse({ status: 404, description: 'OTP not found' })
  async findOne(@Param('id') id: string): Promise<OtpResponseDto> {
    const otp = await this.otpService.findOne(id);
    return {
      id: otp.id,
      phone: otp.phone,
      status: otp.status,
      expiresAt: otp.expiresAt.toISOString(),
      verifiedAt: otp.verifiedAt?.toISOString(),
      createdAt: otp.createdAt.toISOString(),
    };
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel a pending OTP verification' })
  @ApiParam({ name: 'id', description: 'OTP ID' })
  @ApiResponse({ status: 204, description: 'OTP cancelled' })
  @ApiResponse({ status: 400, description: 'OTP is not pending' })
  @ApiResponse({ status: 404, description: 'OTP not found' })
  async cancel(@Param('id') id: string): Promise<void> {
    return this.otpService.cancel(id);
  }
}
