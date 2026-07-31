import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { AgentProtocolError } from './agent.errors';
import { AgentService } from './agent.service';

import type {
  AgentProofAuthentication,
  AgentRequestAuthentication,
  WebUserPrincipal,
} from './agent.types';

interface AuthenticatedHttpRequest {
  user?: WebUserPrincipal;
}

@Controller('v1')
export class AgentController {
  constructor(@Inject(AgentService) private readonly agentService: AgentService) {}

  @Post('agent-pairing-sessions')
  createPairingSession(
    @Req() request: AuthenticatedHttpRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
  ) {
    return this.agentService.createPairingSession(this.requireUser(request), body, idempotencyKey);
  }

  @Post('agent-pairing-sessions/:pairingSessionId\\:claim')
  @HttpCode(202)
  claimPairingSession(
    @Param('pairingSessionId') pairingSessionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
  ) {
    return this.agentService.claimPairingSession(pairingSessionId, body, idempotencyKey);
  }

  @Post('agent-pairing-sessions/:pairingSessionId\\:confirm')
  @HttpCode(200)
  confirmPairingSession(
    @Req() request: AuthenticatedHttpRequest,
    @Param('pairingSessionId') pairingSessionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
  ) {
    return this.agentService.confirmPairingSession(
      this.requireUser(request),
      pairingSessionId,
      body,
      idempotencyKey,
    );
  }

  @Post('agent-tokens')
  @HttpCode(200)
  exchangeAgentToken(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-agent-nonce') nonce: unknown,
    @Headers('x-agent-proof') proof: unknown,
  ) {
    return this.agentService.exchangeAgentToken(
      body,
      this.proofAuthentication(idempotencyKey, nonce, proof),
    );
  }

  @Post('agents/:agentId/commands\\:claim')
  @HttpCode(200)
  claimCommand(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-agent-nonce') nonce: unknown,
    @Headers('x-agent-proof') proof: unknown,
  ) {
    return this.agentService.claimCommand(
      agentId,
      body,
      this.requestAuthentication(authorization, idempotencyKey, nonce, proof),
    );
  }

  @Post('agents/:agentId/commands/:commandId/receipts')
  @HttpCode(200)
  createCommandReceipt(
    @Param('agentId') agentId: string,
    @Param('commandId') commandId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-agent-nonce') nonce: unknown,
    @Headers('x-agent-proof') proof: unknown,
  ) {
    return this.agentService.createCommandReceipt(
      agentId,
      commandId,
      body,
      this.requestAuthentication(authorization, idempotencyKey, nonce, proof),
    );
  }

  @Post('agents/:agentId/heartbeat')
  @HttpCode(204)
  heartbeat(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-agent-nonce') nonce: unknown,
    @Headers('x-agent-proof') proof: unknown,
  ): void {
    this.agentService.heartbeat(
      agentId,
      body,
      this.requestAuthentication(authorization, idempotencyKey, nonce, proof),
    );
  }

  @Post('agents/:agentId\\:revoke')
  @HttpCode(200)
  revokeAgent(
    @Req() request: AuthenticatedHttpRequest,
    @Param('agentId') agentId: string,
    @Headers('idempotency-key') idempotencyKey: unknown,
  ) {
    return this.agentService.revokeAgent(this.requireUser(request), agentId, idempotencyKey);
  }

  private requireUser(request: AuthenticatedHttpRequest): WebUserPrincipal {
    if (request.user === undefined) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    return request.user;
  }

  private proofAuthentication(
    idempotencyKey: unknown,
    nonce: unknown,
    proof: unknown,
  ): AgentProofAuthentication {
    return {
      idempotency_key: this.header(idempotencyKey),
      nonce: this.header(nonce),
      proof: this.header(proof),
    };
  }

  private requestAuthentication(
    authorization: unknown,
    idempotencyKey: unknown,
    nonce: unknown,
    proof: unknown,
  ): AgentRequestAuthentication {
    const authorizationHeader = this.header(authorization);
    if (!authorizationHeader.startsWith('Bearer ')) {
      throw new AgentProtocolError('AUTH_REQUIRED');
    }
    return {
      access_token: authorizationHeader.slice('Bearer '.length),
      ...this.proofAuthentication(idempotencyKey, nonce, proof),
    };
  }

  private header(value: unknown): string {
    if (typeof value !== 'string') {
      throw new AgentProtocolError('VALIDATION_FAILED');
    }
    return value;
  }
}
