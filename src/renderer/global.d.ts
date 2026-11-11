import { NanoElectronBridge } from '../shared/types';

declare global {
  interface Window {
    antigravity: NanoElectronBridge;
  }
}

export {};

