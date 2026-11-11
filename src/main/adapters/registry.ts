import { PlatformId } from '../../shared/types';
import { HotmartAdapter } from './hotmartAdapter';
import { KiwifyAdapter } from './kiwifyAdapter';
import { IPlatformAdapter } from './platformAdapter';

export class AdapterRegistry {
  private readonly adapters = new Map<PlatformId, IPlatformAdapter>();

  constructor(customAdapters?: IPlatformAdapter[]) {
    if (customAdapters) {
      for (const adapter of customAdapters) {
        this.adapters.set(adapter.platformId, adapter);
      }
    } else {
      this.adapters.set('hotmart', new HotmartAdapter());
      this.adapters.set('kiwify', new KiwifyAdapter());
    }
  }

  get(platform: PlatformId): IPlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`Unsupported platform adapter: ${platform}`);
    }
    return adapter;
  }
}

