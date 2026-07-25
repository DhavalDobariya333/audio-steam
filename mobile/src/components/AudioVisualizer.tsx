/**
 * AudioVisualizer.tsx — React Native decibel visualizer.
 *
 * Takes a live decibel level (-160 to 0) and renders a pulsing,
 * aesthetic wave effect so the host knows audio is being captured.
 */

import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated } from 'react-native';

interface Props {
  dbLevel: number; // -160 to 0
  isRecording: boolean;
}

const AudioVisualizer: React.FC<Props> = ({ dbLevel, isRecording }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    if (!isRecording) {
      Animated.timing(scaleAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
      Animated.timing(opacityAnim, { toValue: 0.1, duration: 500, useNativeDriver: true }).start();
      return;
    }

    // Convert dB to a scale factor (1.0 to 1.8)
    // -60dB is quiet, 0dB is loud
    let normalized = (dbLevel + 60) / 60;
    if (normalized < 0) normalized = 0;
    if (normalized > 1) normalized = 1;
    
    const targetScale = 1 + (normalized * 0.8);
    const targetOpacity = 0.2 + (normalized * 0.5);

    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: targetScale,
        friction: 6,
        tension: 40,
        useNativeDriver: true,
      }),
      Animated.spring(opacityAnim, {
        toValue: targetOpacity,
        friction: 6,
        tension: 40,
        useNativeDriver: true,
      })
    ]).start();

  }, [dbLevel, isRecording]);

  return (
    <View style={styles.container}>
      <Animated.View 
        style={[
          styles.ring1, 
          { 
            transform: [{ scale: scaleAnim }],
            opacity: opacityAnim
          }
        ]} 
      />
      <View style={styles.centerDot}>
        <View style={[styles.innerDot, isRecording && styles.innerDotActive]} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 40,
  },
  ring1: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#ff3366',
  },
  centerDot: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255, 51, 102, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 51, 102, 0.5)',
  },
  innerDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#4a4a5a', // Off
  },
  innerDotActive: {
    backgroundColor: '#ff3366',
  }
});

export default AudioVisualizer;
