import { StyleSheet, Text, View, Button, Alert, TouchableOpacity } from 'react-native';
import React, { useEffect, useState, useRef } from 'react';
import { Accelerometer } from 'expo-sensors'; // <-- THE NEW HARDWARE LINK
import { getNearestServices, syncLiveArea } from '../services/DatabaseService'; 
import { getLiveLocation } from '../services/LocationService';
import { sendEmergencySMS } from '../services/SmsService'; 

export default function HomeScreen() {
  const [isSyncing, setIsSyncing] = useState(true);
  const [countdown, setCountdown] = useState(null); // Holds the 10-second timer
  const timerRef = useRef(null); // Keeps track of the interval

  // 1. Background Sync (Runs once on app load)
  useEffect(() => {
    const initializeApp = async () => {
      try {
        const liveCoords = await getLiveLocation();
        await syncLiveArea(liveCoords.latitude, liveCoords.longitude);
      } catch (error) {
        console.log("Background sync skipped.");
      } finally {
        setIsSyncing(false);
      }
    };
    initializeApp();
  }, []); 

  // 2. The Auto-Crash Detector (Always listening in the background)
  useEffect(() => {
    // Read the sensor 5 times a second
    Accelerometer.setUpdateInterval(200);

    const subscription = Accelerometer.addListener(data => {
      // If we are already counting down, ignore new bumps
      if (timerRef.current) return;

      const { x, y, z } = data;
      // Calculate total G-force (1G is resting gravity)
      const totalGForce = Math.sqrt(x * x + y * y + z * z);

      // If G-force exceeds 4.0Gs, we assume a severe collision occurred
      // (You can lower this to 2.0 to test it by shaking your phone really hard!)
      if (totalGForce > 4.0) {
        triggerCrashSequence();
      }
    });

    return () => subscription.remove();
  }, []);

  const triggerCrashSequence = () => {
    console.log("CRASH DETECTED! Starting SOS Countdown...");
    let timeLeft = 10;
    setCountdown(timeLeft);

    timerRef.current = setInterval(() => {
      timeLeft -= 1;
      setCountdown(timeLeft);

      if (timeLeft <= 0) {
        // Time is up! Fire the SOS automatically.
        cancelCrashSequence(); 
        triggerSOS(); 
      }
    }, 1000);
  };

  const cancelCrashSequence = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      setCountdown(null);
      console.log("Crash sequence cancelled by user.");
    }
  };

  // 3. The SOS Dispatch Engine
  const triggerSOS = async () => {
    try {
      console.log("Acquiring Live GPS Target...");
      const liveCoords = await getLiveLocation();
      
      console.log("Searching Offline Database...");
      const closestServices = await getNearestServices(liveCoords.latitude, liveCoords.longitude, 'mechanic');
      
      console.log("Deploying Automated SMS...");
      // Replace '112' with your phone number to test!
      await sendEmergencySMS(liveCoords, closestServices, ['112']);
      
    } catch (error) {
      console.error("SOS System Failure:", error);
      Alert.alert("Error", error.message);
    }
  };

  // ==========================================
  // UI RENDERING: CRASH MODE VS NORMAL MODE
  // ==========================================
  
  if (countdown !== null) {
    // THE CRASH UI (Flashes red, massive cancel button)
    return (
      <View style={[styles.container, { backgroundColor: '#FF0000' }]}>
        <Text style={styles.crashTitle}>CRASH DETECTED</Text>
        <Text style={styles.crashSubtitle}>Auto-dispatching SOS in:</Text>
        <Text style={styles.timerText}>{countdown}s</Text>
        
        <TouchableOpacity style={styles.cancelButton} onPress={cancelCrashSequence}>
          <Text style={styles.cancelButtonText}>I AM SAFE (CANCEL)</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // THE NORMAL UI
  return (
    <View style={styles.container}>
      <Text style={styles.title}>RoadSOS: Active</Text>
      <Text style={styles.subtitle}>
        {isSyncing ? "Caching local area..." : "Crash Detection Armed"}
      </Text>
      
      <View style={styles.buttonContainer}>
        <Button 
           title="MANUAL SOS OVERRIDE" 
           color="#FF0000" 
           onPress={triggerSOS} 
           disabled={isSyncing} 
        /> 
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5F5F5' },
  title: { fontSize: 28, fontWeight: 'bold' },
  subtitle: { fontSize: 16, color: 'gray', marginBottom: 40 },
  buttonContainer: { width: '80%', padding: 10, backgroundColor: '#fff', borderRadius: 10, elevation: 5 },
  
  // Crash UI Styles
  crashTitle: { fontSize: 36, fontWeight: 'bold', color: '#FFF', textAlign: 'center' },
  crashSubtitle: { fontSize: 20, color: '#FFF', marginTop: 10 },
  timerText: { fontSize: 80, fontWeight: 'bold', color: '#FFF', marginVertical: 20 },
  cancelButton: { backgroundColor: '#FFF', padding: 20, borderRadius: 10, marginTop: 40, width: '80%' },
  cancelButtonText: { color: '#FF0000', fontSize: 20, fontWeight: 'bold', textAlign: 'center' }
});