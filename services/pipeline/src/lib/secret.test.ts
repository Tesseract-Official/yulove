import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGeminiApiKey, resetGeminiApiKeyCache } from './secret.js';

const secrets = mockClient(SecretsManagerClient);

beforeEach(() => {
  secrets.reset();
  resetGeminiApiKeyCache();
});

describe('getGeminiApiKey', () => {
  it('reads the secret by name and trims it', async () => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: '  key-123\n' });

    await expect(getGeminiApiKey('dsa-judge/gemini-api-key')).resolves.toBe('key-123');
    expect(secrets.commandCalls(GetSecretValueCommand)[0]?.args[0].input).toEqual({
      SecretId: 'dsa-judge/gemini-api-key',
    });
  });

  it('is fetched once and cached across invocations', async () => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: 'key-123' });

    await getGeminiApiKey('s');
    await getGeminiApiKey('s');
    await Promise.all([getGeminiApiKey('s'), getGeminiApiKey('s')]);

    expect(secrets.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('does not cache a failure', async () => {
    secrets
      .on(GetSecretValueCommand)
      .rejectsOnce(new Error('throttled'))
      .resolves({ SecretString: 'k' });

    await expect(getGeminiApiKey('s')).rejects.toThrow('throttled');
    await expect(getGeminiApiKey('s')).resolves.toBe('k');
  });

  it.each([undefined, '', '   '])('rejects an empty secret (%j)', async (value) => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString: value });
    await expect(getGeminiApiKey('s')).rejects.toThrow(/empty/);
  });
});
