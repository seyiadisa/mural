import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceError } from './errors.js';

export interface EncryptedWebSecret { nonce: Buffer; ciphertext: Buffer; authTag: Buffer }

function encryptionKey(): Buffer {
  const configured = process.env.MURAL_SECRETS_ENCRYPTION_KEY;
  if (!configured || !/^[a-f0-9]{64}$/i.test(configured)) throw new ServiceError('web_secrets_not_configured', 503);
  return Buffer.from(configured, 'hex');
}

export function encryptWebSecret(value: unknown, purpose: string, ownerID: string): EncryptedWebSecret {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`mural-web:${purpose}:${ownerID}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptWebSecret<T>(record: EncryptedWebSecret, purpose: string, ownerID: string): T {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), record.nonce);
    decipher.setAAD(Buffer.from(`mural-web:${purpose}:${ownerID}`));
    decipher.setAuthTag(record.authTag);
    const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch {
    throw new ServiceError('web_secret_unavailable', 503);
  }
}

export function webSecretsConfigured(): boolean {
  return Boolean(process.env.MURAL_SECRETS_ENCRYPTION_KEY && /^[a-f0-9]{64}$/i.test(process.env.MURAL_SECRETS_ENCRYPTION_KEY));
}
