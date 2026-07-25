/**
 * NetworkMonitor.ts — Tracks network connectivity state.
 */

import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

type NetworkListener = (isOnline: boolean) => void;

class NetworkMonitor {
  private isOnline: boolean = true;
  private listeners: Set<NetworkListener> = new Set();
  private unsubscribe: (() => void) | null = null;

  start() {
    this.unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const online = state.isConnected && state.isInternetReachable !== false;
      
      if (this.isOnline !== online) {
        this.isOnline = !!online;
        this.notifyListeners();
      }
    });
  }

  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  getIsOnline(): boolean {
    return this.isOnline;
  }

  addListener(listener: NetworkListener) {
    this.listeners.add(listener);
  }

  removeListener(listener: NetworkListener) {
    this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener(this.isOnline));
  }
}

export default new NetworkMonitor();
