import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OsKeyProtector {
  protect(plain: Buffer): Buffer;
  unprotect(cipher: Buffer): Buffer;
}

/**
 * Default protector wrapping Electron's `safeStorage` (DPAPI / Keychain / libsecret)
 * when running inside Electron, with a machine-derived AES-256-GCM fallback if explicitly requested in tests.
 */
export function createElectronOsProtector(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(encrypted: Buffer): string;
}): OsKeyProtector {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS Secure Storage (Keychain / Credential Manager / Secret Service) is unavailable.');
  }
  return {
    protect(plain: Buffer): Buffer {
      return safeStorage.encryptString(plain.toString('base64'));
    },
    unprotect(cipher: Buffer): Buffer {
      const b64 = safeStorage.decryptString(cipher);
      return Buffer.from(b64, 'base64');
    },
  };
}

export function createTestProtector(secretSeed = 'test-os-vault-seed'): OsKeyProtector {
  const key = crypto.createHash('sha256').update(secretSeed).digest();
  return {
    protect(plain: Buffer): Buffer {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    unprotect(payload: Buffer): Buffer {
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const enc = payload.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    },
  };
}

export interface EncryptedBlob {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

/**
 * Manages AES-256-GCM session token encryption and machine-bound HMAC-SHA256 signatures
 * backed by an OS-protected 32-byte master key.
 */
export class SecretStore {
  private readonly secretsDir: string;
  private readonly masterKeyFile: string;
  private readonly protector: OsKeyProtector;
  private masterKey: Buffer | null = null;

  constructor(vaultDir: string, protector: OsKeyProtector) {
    this.secretsDir = path.join(vaultDir, 'secrets');
    this.masterKeyFile = path.join(this.secretsDir, 'master.key.enc');
    this.protector = protector;
    fs.mkdirSync(this.secretsDir, { recursive: true });
  }

  private getOrCreateMasterKey(): Buffer {
    if (this.masterKey) {
      return this.masterKey;
    }
    if (fs.existsSync(this.masterKeyFile)) {
      const protectedBytes = fs.readFileSync(this.masterKeyFile);
      const rawKey = this.protector.unprotect(protectedBytes);
      if (rawKey.length !== 32) {
        throw new Error('Corrupted vault master key length.');
      }
      this.masterKey = rawKey;
      return rawKey;
    }
    const generated = crypto.randomBytes(32);
    const protectedBytes = this.protector.protect(generated);
    fs.writeFileSync(this.masterKeyFile, protectedBytes, { mode: 0o600 });
    this.masterKey = generated;
    return generated;
  }

  encryptJson(credentialRef: string, payload: unknown): void {
    const key = this.getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const blob: EncryptedBlob = {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };
    const targetPath = this.resolveCredentialPath(credentialRef);
    fs.writeFileSync(targetPath, JSON.stringify(blob), { mode: 0o600 });
  }

  decryptJson<T>(credentialRef: string): T | null {
    const targetPath = this.resolveCredentialPath(credentialRef);
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    const raw = fs.readFileSync(targetPath, 'utf8');
    const blob = JSON.parse(raw) as EncryptedBlob;
    const key = this.getOrCreateMasterKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(blob.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  }

  deleteCredential(credentialRef: string): void {
    const targetPath = this.resolveCredentialPath(credentialRef);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  }

  getMachineFingerprint(): string {
    const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  signForLocalMachine(data: string): string {
    const key = this.getOrCreateMasterKey();
    const fingerprint = this.getMachineFingerprint();
    return crypto
      .createHmac('sha256', key)
      .update(`${fingerprint}:${data}`)
      .digest('hex');
  }

  verifyLocalMachineSignature(data: string, signatureHex: string): boolean {
    const expected = this.signForLocalMachine(data);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  static hashIdentity(value: string): string {
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  }

  private resolveCredentialPath(credentialRef: string): string {
    const safeRef = credentialRef.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.secretsDir, `${safeRef}.cred.json`);
  }
}

