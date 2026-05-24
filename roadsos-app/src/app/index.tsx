import { StyleSheet, Text, View, Button, Alert, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import React, { useEffect, useState, useRef } from 'react';
import { Accelerometer } from 'expo-sensors';
import * as Location from 'expo-location'; // Using Expo's native location tracker

// Import our new Smart Vault Engine
import { initializeSmartVault, syncAreaIfNeeded, getLocalEmergencyServices } from '../services/DatabaseService'; 
import { sendEmergencySMS } from '../services/SmsService'; 

export default function HomeScreen() {
  const [isSyncing, setIsSyncing] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [nearbyServices, setNearbyServices] = useState<any[]>([]); // Holds our UI data
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // ==========================================
  // 1. THE SILENT CO-PILOT (Boot Sequence)
  // ==========================================
  useEffect(() => {
    const bootSystem = async () => {
      try {
        console.log("Booting Smart Vault...");
        await initializeSmartVault();

        console.log("Requesting GPS Permissions...");
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert("Permission Denied", "RoadSoS needs GPS to build your safety net.");
          setIsSyncing(false);
          return;
        }

        console.log("Acquiring Satellite Lock...");
        const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const { latitude, longitude } = location.coords;

        // Trigger the Smart Vault to check memory and download if needed
        await syncAreaIfNeeded(latitude, longitude);

        // Pull the local data to show on the screen
        const localData = await getLocalEmergencyServices(latitude, longitude);
        setNearbyServices(localData);

      } catch (error) {
        console.log("Boot sequence error:", error);
      } finally {
        setIsSyncing(false);
      }
    };

    bootSystem();
  }, []); 

  // ==========================================
  // 2. THE AUTO-CRASH DETECTOR
  // ==========================================
  useEffect(() => {
    Accelerometer.setUpdateInterval(200);
    const subscription = Accelerometer.addListener(data => {
      if (timerRef.current) return;
      const { x, y, z } = data;
      const totalGForce = Math.sqrt(x * x + y * y + z * z);

      if (totalGForce > 4.0) {
        triggerCrashSequence();
      }
    });
    return () => subscription.remove();
  }, []);

  const triggerCrashSequence = () => {
    let timeLeft = 10;
    setCountdown(timeLeft);
    timerRef.current = setInterval(() => {
      timeLeft -= 1;
      setCountdown(timeLeft);
      if (timeLeft <= 0) {
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
    }
  };

  const triggerSOS = async () => {
    try {
      const location = await Location.getCurrentPositionAsync({});
      await sendEmergencySMS(location.coords, nearbyServices, ['112']);
    } catch (error: any) {
      Alert.alert("SOS Failure", error.message);
    }
  };

  // ==========================================
  // UI RENDERING
  // ==========================================
  
  if (countdown !== null) {
    // CRASH OVERRIDE UI
    return (
      <View style={[styles.container, { backgroundColor: '#D32F2F' }]}>
        <Text style={styles.crashTitle}>CRASH DETECTED</Text>
        <Text style={styles.crashSubtitle}>Auto-dispatching SOS in:</Text>
        <Text style={styles.timerText}>{countdown}s</Text>
        <TouchableOpacity style={styles.cancelButton} onPress={cancelCrashSequence}>
          <Text style={styles.cancelButtonText}>I AM SAFE (CANCEL)</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isSyncing) {
    // SATELLITE SEARCHING UI
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#D32F2F" />
        <Text style={[styles.title, {marginTop: 20}]}>Securing Area...</Text>
        <Text style={styles.subtitle}>Switching to satellite GPS & verifying offline vault.</Text>
      </View>
    );
  }

  // NORMAL UI WITH DATA CARDS
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>RoadSOS: Active</Text>
        <Text style={styles.subtitle}>Crash Detection Armed • Offline Vault Ready</Text>
      </View>

      <View style={styles.listContainer}>
        <Text style={styles.sectionTitle}>Nearest Emergency Services</Text>
        {nearbyServices.length === 0 ? (
          <Text style={styles.emptyText}>No emergency POIs found in this 10km map tile.</Text>
        ) : (
          <FlatList
            data={nearbyServices}
            keyExtractor={(item) => item.id.toString()}
            renderItem={({ item }) => (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.cardType}>{item.type.toUpperCase()}</Text>
              </View>
            )}
          />
        )}
      </View>
      
      <View style={styles.buttonContainer}>
        <Button title="MANUAL SOS OVERRIDE" color="#D32F2F" onPress={triggerSOS} /> 
      </View>
    </View>
  );
}

// ==========================================
// STYLESHEET
// ==========================================
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA', paddingTop: 60, paddingHorizontal: 20 },
  header: { alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 26, fontWeight: '900', color: '#111' },
  subtitle: { fontSize: 14, color: '#666', marginTop: 5, fontWeight: '600' },
  
  // Card UI Styles
  listContainer: { flex: 1, width: '100%' },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  emptyText: { color: '#888', fontStyle: 'italic', textAlign: 'center', marginTop: 20 },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 5, elevation: 2 },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#222' },
  cardType: { fontSize: 12, color: '#D32F2F', marginTop: 4, fontWeight: '700' },

  buttonContainer: { width: '100%', paddingBottom: 40, paddingTop: 10 },
  
  // Crash UI
  crashTitle: { fontSize: 36, fontWeight: '900', color: '#FFF', textAlign: 'center', marginTop: 100 },
  crashSubtitle: { fontSize: 20, color: '#FFF', marginTop: 10, textAlign: 'center' },
  timerText: { fontSize: 100, fontWeight: 'bold', color: '#FFF', textAlign: 'center', marginVertical: 20 },
  cancelButton: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, marginTop: 40, alignSelf: 'center', width: '90%' },
  cancelButtonText: { color: '#D32F2F', fontSize: 20, fontWeight: '900', textAlign: 'center' }
});