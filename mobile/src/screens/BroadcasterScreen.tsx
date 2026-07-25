/**
 * BroadcasterScreen.tsx — The primary Host interface.
 */

import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, StatusBar, Modal, TextInput } from 'react-native';
import AudioCapture, { AudioStats } from '../services/AudioCapture';
import SyncWorker from '../services/SyncWorker';
import NetworkMonitor from '../services/NetworkMonitor';
import ConfigManager from '../services/ConfigManager';
import AudioVisualizer from '../components/AudioVisualizer';
import VIForegroundService from '@voximplant/react-native-foreground-service';

const BroadcasterScreen: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [stats, setStats] = useState<AudioStats>({ duration: 0, dbLevel: -160, chunksCaptured: 0 });
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    NetworkMonitor.start();
    NetworkMonitor.addListener(setIsOnline);
    
    // Android Foreground Service config channel
    createForegroundChannel();
    
    // Load config
    ConfigManager.getServerUrl().then(setServerUrl);
    
    return () => {
      NetworkMonitor.stop();
      NetworkMonitor.removeListener(setIsOnline);
    };
  }, []);

  const createForegroundChannel = async () => {
    try {
      const channelConfig = {
        id: 'audio_stream_channel',
        name: 'Audio Broadcast Service',
        description: 'Keeps the microphone active in the background',
        enableVibration: false
      };
      await VIForegroundService.getInstance().createNotificationChannel(channelConfig);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      // STOP
      setIsRecording(false);
      await AudioCapture.stop();
      SyncWorker.stop();
      
      if (sessionId) {
        await SyncWorker.endSession(sessionId);
      }
      setSessionId(null);
      
      try {
        await VIForegroundService.getInstance().stopService();
      } catch (e) { }

    } else {
      // START
      const newSessionId = await SyncWorker.createSession('Host Device');
      if (!newSessionId) {
        alert('Could not connect to server. Check network.');
        return;
      }
      
      setSessionId(newSessionId);
      setIsRecording(true);
      
      // Start Android foreground service to prevent Doze mode killing us
      try {
        const notificationConfig = {
          channelId: 'audio_stream_channel',
          id: 3456,
          title: 'Audio Stream Live',
          text: 'Broadcasting in background...',
          icon: 'ic_notification'
        };
        await VIForegroundService.getInstance().startService(notificationConfig);
      } catch (e) { }

      // Start services
      SyncWorker.start(newSessionId);
      await AudioCapture.start(newSessionId, (newStats) => {
        setStats(newStats);
      });
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#06060a" />
      
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Host Broadcast</Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, isOnline ? styles.dotOnline : styles.dotOffline]} />
            <Text style={styles.statusText}>{isOnline ? 'Online' : 'Offline Mode'}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.settingsBtn} onPress={() => setShowSettings(true)}>
          <Text style={styles.settingsBtnText}>⚙️ Setup</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.center}>
        <AudioVisualizer dbLevel={stats.dbLevel} isRecording={isRecording} />
        
        <Text style={styles.timeText}>{formatTime(stats.duration)}</Text>
        
        <View style={styles.statsCard}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>CHUNKS</Text>
            <Text style={styles.statValue}>{stats.chunksCaptured}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>SYNC</Text>
            <Text style={styles.statValue}>{isOnline ? 'Active' : 'Queued'}</Text>
          </View>
        </View>
      </View>

      <View style={styles.footer}>
        {!isOnline && isRecording && (
          <View style={styles.offlineWarning}>
            <Text style={styles.offlineText}>Network dropped. Recording safely to disk.</Text>
          </View>
        )}
        
        <TouchableOpacity 
          style={[styles.recordBtn, isRecording && styles.recordBtnActive]} 
          onPress={toggleRecording}
          activeOpacity={0.8}
        >
          <Text style={styles.recordBtnText}>
            {isRecording ? 'END BROADCAST' : 'GO LIVE'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Settings Modal */}
      <Modal visible={showSettings} transparent={true} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Server Configuration</Text>
            <Text style={styles.modalDesc}>Enter your Render.com backend URL (or localhost)</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://your-server.onrender.com"
              placeholderTextColor="#656580"
              autoCapitalize="none"
              keyboardType="url"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setShowSettings(false)}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnSave} onPress={async () => {
                await ConfigManager.setServerUrl(serverUrl);
                setShowSettings(false);
              }}>
                <Text style={styles.modalBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#06060a' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 24,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotOnline: { backgroundColor: '#22c55e' },
  dotOffline: { backgroundColor: '#ef4444' },
  statusText: { color: '#a0a0b8', fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  
  settingsBtn: { backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  settingsBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  timeText: { color: '#fff', fontSize: 48, fontWeight: '300', fontVariant: ['tabular-nums'], marginBottom: 32 },
  
  statsCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(30, 30, 45, 0.75)',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  statBox: { paddingHorizontal: 24, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  statLabel: { color: '#a0a0b8', fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  statValue: { color: '#fff', fontSize: 18, fontWeight: '600' },

  footer: { padding: 24, paddingBottom: 40 },
  offlineWarning: { backgroundColor: 'rgba(239, 68, 68, 0.15)', padding: 12, borderRadius: 8, marginBottom: 16, alignItems: 'center' },
  offlineText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  
  recordBtn: {
    backgroundColor: '#ff3366',
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ff3366',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
  },
  recordBtnActive: { backgroundColor: '#2d2d41', shadowOpacity: 0, elevation: 0 },
  recordBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 1 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', padding: 24 },
  modalBox: { backgroundColor: '#1e1e2d', padding: 24, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  modalDesc: { color: '#a0a0b8', fontSize: 13, marginBottom: 20 },
  input: { backgroundColor: '#06060a', color: '#fff', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', marginBottom: 20 },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalBtnCancel: { flex: 1, padding: 14, alignItems: 'center', backgroundColor: 'transparent' },
  modalBtnSave: { flex: 1, padding: 14, alignItems: 'center', backgroundColor: '#ff3366', borderRadius: 12 },
  modalBtnText: { color: '#fff', fontWeight: '700' }
});

export default BroadcasterScreen;
