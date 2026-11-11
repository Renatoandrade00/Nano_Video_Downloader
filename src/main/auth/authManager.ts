import crypto from 'node:crypto';
import { AccountRecord, PlatformId } from '../../shared/types';
import { DecryptedSession } from '../adapters/platformAdapter';
import { AdapterRegistry } from '../adapters/registry';
import { VaultDatabase } from '../vault/database';
import { SecretStore } from '../vault/secretStore';
import { buildSessionRecord, openIsolatedWebBridgeLogin, WebBridgeResult } from './webBridge';

export type WebBridgeRunner = (
  platform: PlatformId,
  partitionId: string,
) => Promise<WebBridgeResult>;

export class AuthManager {
  private readonly db: VaultDatabase;
  private readonly secrets: SecretStore;
  private readonly adapters: AdapterRegistry;
  private readonly runWebBridge?: WebBridgeRunner;

  constructor(
    db: VaultDatabase,
    secrets: SecretStore,
    adapters: AdapterRegistry,
    runWebBridge?: WebBridgeRunner,
  ) {
    this.db = db;
    this.secrets = secrets;
    this.adapters = adapters;
    this.runWebBridge = runWebBridge;
  }

  listAccounts(): AccountRecord[] {
    return this.db.listAccounts();
  }

  async connectPlatform(platform: PlatformId): Promise<AccountRecord> {
    const adapter = this.adapters.get(platform);
    const config = adapter.getLoginConfig();
    const accountId = `${platform}-${crypto.randomUUID().slice(0, 8)}`;

    const captured = this.runWebBridge
      ? await this.runWebBridge(platform, accountId)
      : await openIsolatedWebBridgeLogin(config, accountId);

    const session = buildSessionRecord(config, captured);
    const credentialRef = `cred_${accountId}`;
    this.secrets.encryptJson(credentialRef, session);

    const account: AccountRecord = {
      id: accountId,
      platform,
      externalUserId: session.externalUserId,
      emailHash: SecretStore.hashIdentity(session.email),
      credentialRef,
      status: 'CONNECTED',
      lastVerifiedAt: new Date().toISOString(),
    };
    this.db.upsertAccount(account);
    return account;
  }

  getDecryptedSession(accountId: string): DecryptedSession | null {
    const account = this.db.getAccount(accountId);
    if (!account || account.status === 'DISCONNECTED') {
      return null;
    }
    return this.secrets.decryptJson<DecryptedSession>(account.credentialRef);
  }

  disconnectAccount(accountId: string): void {
    const account = this.db.getAccount(accountId);
    if (!account) return;
    this.secrets.deleteCredential(account.credentialRef);
    this.db.updateAccountStatus(accountId, 'DISCONNECTED', new Date().toISOString());
  }
}

