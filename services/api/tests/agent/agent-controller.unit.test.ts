import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AgentModule } from '../../src/modules/agent';

describe('AgentController contract routes', () => {
  it('mounts the OpenAPI colon-suffixed pairing claim route', async () => {
    const app = await NestFactory.create(AgentModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const response = await fetch(
        `${await app.getUrl()}/v1/agent-pairing-sessions/${randomUUID()}:claim`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `controller:${randomUUID()}`,
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
        },
      });
    } finally {
      await app.close();
    }
  });
});
