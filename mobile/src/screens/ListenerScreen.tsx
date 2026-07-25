/**
 * ListenerScreen.tsx — The Mobile Listener Interface.
 *
 * Uses react-native-video to play the HLS stream from the server.
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native';
import Video from 'react-native-video';

const HLS_URL = 'http://10.0.2.2:8765/storage/sessions/active/hls/live.m3u8'; // In a real app, you'd select a session

const ListenerScreen: React.FC = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const videoRef = useRef<Video>(null);

  useEffect(() => {
    // Auto-play on mount
    setIsPlaying(true);
  }, []);

  const onBuffer = ({ isBuffering }: { isBuffering: boolean }) => {
    setIsBuffering(isBuffering);
  };

  const onError = (e: any) => {
    console.error('Video Player Error:', e);
    setError('Failed to load live stream.');
    setIsBuffering(false);
    setIsPlaying(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Live Listener</Text>
        <View style={styles.statusBadge}>
          <Text style={styles.statusText}>LIVE</Text>
        </View>
      </View>

      <View style={styles.playerContainer}>
        <View style={styles.visualizerMock}>
          {isBuffering ? (
            <ActivityIndicator size="large" color="#ff3366" />
          ) : error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <Text style={styles.readyText}>Audio Streaming</Text>
          )}
        </View>

        {/* Hidden video component just used for audio HLS playback */}
        <Video
          ref={videoRef}
          source={{ uri: HLS_URL, type: 'm3u8' }}
          audioOnly={true}
          paused={!isPlaying}
          onBuffer={onBuffer}
          onError={onError}
          playInBackground={true}
          style={styles.hiddenVideo}
        />
      </View>

      <View style={styles.controls}>
        <TouchableOpacity 
          style={styles.playBtn}
          onPress={() => setIsPlaying(!isPlaying)}
        >
          <Text style={styles.playBtnText}>{isPlaying ? 'PAUSE' : 'PLAY'}</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={styles.jumpBtn}
          onPress={() => {
             if (videoRef.current) {
                // Seek to end (approx live edge)
                videoRef.current.seek(99999);
             }
          }}
        >
          <Text style={styles.jumpBtnText}>JUMP TO LIVE</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#06060a' },
  header: { padding: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  statusBadge: { backgroundColor: 'rgba(255, 51, 102, 0.2)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
  statusText: { color: '#ff3366', fontSize: 12, fontWeight: '800' },
  
  playerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  visualizerMock: { width: '100%', height: 200, backgroundColor: 'rgba(30,30,45,0.7)', borderRadius: 24, justifyContent: 'center', alignItems: 'center' },
  readyText: { color: '#a0a0b8', fontSize: 16, fontWeight: '500' },
  errorText: { color: '#ef4444', fontSize: 14, fontWeight: '600' },
  hiddenVideo: { width: 0, height: 0 },
  
  controls: { padding: 24, paddingBottom: 48, flexDirection: 'row', gap: 16 },
  playBtn: { flex: 1, backgroundColor: '#ff3366', height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  playBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jumpBtn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  jumpBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' }
});

export default ListenerScreen;
