import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Button, Alert, TouchableOpacity, TextInput, Modal, Platform } from 'react-native';
import { Accelerometer } from 'expo-sensors';
import * as Location from 'expo-location';

import { saveUserProfile, getUserProfile } from '../services/ProfileService';
import { getLiveLocation } from '../services/LocationService';
import { sendEmergencySMS } from '../services/SmsService';
import { bootstrapOfflineDatabase, getNearestServices, syncLiveArea } from '../services/DatabaseService';

export default function HomeScreen() {
  // --- STATE & REFS ---
  const [isSyncing, setIsSyncing] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [profile, setProfile] = useState({ name: '', bloodType: '', vehicleId: '', emergencyPhone: '' });
  
  // Missing variables for the Crash Sequence
  const [countdown, setCountdown] = useState<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // --- 1. BOOT SEQUENCE ---
  useEffect(() => {
    const initializeApp = async () => {
      try {
        await bootstrapOfflineDatabase();
        
        // CHECK PROFILE FIRST
        const existingProfile = await getUserProfile();
        if (!existingProfile) {
            setShowOnboarding(true); 
        } else {
            setProfile(existingProfile);
        }

        const liveCoords = await getLiveLocation();
        await syncLiveArea(liveCoords.latitude, liveCoords.longitude);
      } catch (error) {
        console.log("App initialized in strict offline mode.");
      } finally {
        setIsSyncing(false);
      }
    };
    initializeApp();
  }, []); 

  // --- 2. THE AUTO-CRASH DETECTOR ---
  useEffect(() => {
    if (Platform.OS === 'web') {
      console.log("Web mode detected. Skipping hardware accelerometer.");
      return; 
    }
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

  // --- 3. THE LIVE DRIVING TRACKER ---
  const getDistanceFromLatLonInKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; 
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
    return R * c; 
  };

  useEffect(() => {
    let locationSubscription: Location.LocationSubscription | null = null;
    let lastSyncedLocation: { latitude: number, longitude: number } | null = null;

    const startDrivingTracker = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 1000, 
        },
        async (location) => {
          const { latitude, longitude } = location.coords;

          if (!lastSyncedLocation) {
            lastSyncedLocation = { latitude, longitude };
            await syncLiveArea(latitude, longitude);
            return;
          }

          const distanceDriven = getDistanceFromLatLonInKm(
            lastSyncedLocation.latitude, lastSyncedLocation.longitude,
            latitude, longitude
          );

          if (distanceDriven >= 10) {
            console.log(`🚙 Traveled ${distanceDriven.toFixed(1)}km. Triggering Rolling Spatial Cache...`);
            lastSyncedLocation = { latitude, longitude };
            await syncLiveArea(latitude, longitude);
          }
        }
      );
    };

    startDrivingTracker();

    return () => {
      if (locationSubscription) locationSubscription.remove();
    };
  }, []);

  // --- FUNCTIONS ---
  const handleSaveProfile = async () => {
      if (!profile.name || !profile.bloodType || !profile.emergencyPhone) {
          alert("Please fill out the vital details to ensure your safety.");
          return;
      }
      await saveUserProfile(profile);
      setShowOnboarding(false); 
  };

  const triggerCrashSequence = () => {
    console.log("CRASH DETECTED! Starting SOS Countdown...");
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
      console.log("Crash sequence cancelled by user.");
    }
  };

  const triggerSOS = async () => {
    try {
      console.log("Acquiring Live GPS Target...");
      const liveCoords = await getLiveLocation();
      
      console.log("Searching Offline Database for Comprehensive Rescue...");
      
      const hospitals = await getNearestServices(liveCoords.latitude, liveCoords.longitude, 'hospital');
      const police = await getNearestServices(liveCoords.latitude, liveCoords.longitude, 'police');
      const ambulances = await getNearestServices(liveCoords.latitude, liveCoords.longitude, 'ambulance');
      const mechanics = await getNearestServices(liveCoords.latitude, liveCoords.longitude, 'mechanic');
      const petrolPumps = await getNearestServices(liveCoords.latitude, liveCoords.longitude, 'petrol_pump');

      const formatDist = (dist: number) => dist < 1 ? `${(dist * 1000).toFixed(0)}m` : `${dist.toFixed(1)}km`;

      const printTop3 = (title: string, dataArray: any[]) => {
        console.log(`\n--- TOP 3 ${title} ---`);
        if (dataArray.length === 0) {
            console.log("No services found in this area.");
            return [];
        }
        const top3 = dataArray.slice(0, 3);
        top3.forEach((item, index) => {
            console.log(`${index + 1}. ${item.name} (${item.phone}) - ${formatDist(item.distance)}`);
        });
        return top3;
      };

      console.log("\n=====================================");
      console.log("🚨 EMERGENCY DISPATCH PAYLOAD 🚨");
      
      const topHospitals = printTop3('HOSPITALS', hospitals);
      const topPolice = printTop3('POLICE STATIONS', police);
      const topAmbulances = printTop3('AMBULANCES', ambulances);
      const topMechanics = printTop3('MECHANICS / REPAIR', mechanics);
      printTop3('PETROL PUMPS (SAFE ZONES)', petrolPumps);
      
      console.log("=====================================\n");
      console.log("Deploying Automated SMS...");
      
      const smsServices = [topHospitals[0], topPolice[0], topMechanics[0]].filter(Boolean);
      await sendEmergencySMS(liveCoords, smsServices, profile, ['112']);
      
    } catch (error: any) {
      console.error("SOS System Failure:", error);
      Alert.alert("Error", error.message);
    }
  };

  // --- UI RENDERING ---

  // 1. If actively crashing, lock the screen to the Crash UI
  if (countdown !== null) {
    return (
      <View style={[styles.container, { backgroundColor: '#FF0000' }]}>
        <Text style={styles.crashTitle}>CRASH DETECTED</Text>
        <Text style={styles.crashSubtitle}>Auto-dispatching SOS in:</Text>
        <Text style={styles.timerText}>{countdown}</Text>
        
        <TouchableOpacity style={styles.cancelButton} onPress={cancelCrashSequence}>
          <Text style={styles.cancelButtonText}>I AM OK - CANCEL</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // 2. Normal App Status UI (With Onboarding Modal overlaid if needed)
  return (
    <View style={styles.container}>
      
      {/* THE VITAL ONBOARDING LOCK SCREEN */}
      <Modal visible={showOnboarding} animationType="slide" transparent={false}>
        <View style={styles.modalContainer}>
          <Text style={styles.headerTitle}>RoadSOS Setup</Text>
          <Text style={styles.subText}>Enter your medical vitals to arm the SOS engine.</Text>
          
          <TextInput 
            style={styles.input} 
            placeholder="Full Name" 
            value={profile.name}
            onChangeText={(text) => setProfile({...profile, name: text})}
          />
          <TextInput 
            style={styles.input} 
            placeholder="Blood Type (e.g., O-, A+)" 
            value={profile.bloodType}
            onChangeText={(text) => setProfile({...profile, bloodType: text})}
          />
          <TextInput 
            style={styles.input} 
            placeholder="Vehicle Registration (e.g., BR01-AB-1234)" 
            value={profile.vehicleId}
            onChangeText={(text) => setProfile({...profile, vehicleId: text})}
          />
          <TextInput 
            style={styles.input} 
            placeholder="Family Emergency Phone Number" 
            keyboardType="phone-pad"
            value={profile.emergencyPhone}
            onChangeText={(text) => setProfile({...profile, emergencyPhone: text})}
          />

          <TouchableOpacity style={styles.saveButton} onPress={handleSaveProfile}>
            <Text style={styles.saveButtonText}>ARM SYSTEM</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* NORMAL HOME SCREEN */}
      <Text style={styles.title}>RoadSOS: Active</Text>
      <Text style={styles.subtitle}>
        {isSyncing ? "Caching local area..." : `Hello, ${profile.name || 'User'}`}
      </Text>
      
      <View style={styles.buttonContainer}>
        <TouchableOpacity 
          style={[styles.sosButton, isSyncing && styles.sosButtonDisabled]}
          onPress={triggerSOS}
          disabled={isSyncing}
          activeOpacity={0.8}
        >
          <Text style={styles.sosButtonText}>
            {isSyncing ? "INITIALIZING..." : "SOS OVERRIDE"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// --- STYLES ---
// --- TACTICAL SOS STYLES ---
const styles = StyleSheet.create({
  // Main Background
  container: { 
    flex: 1, 
    alignItems: 'center', 
    justifyContent: 'center', 
    backgroundColor: '#0F172A' // Deep tactical blue/black
  },
  
  // Dashboard Text
  title: { 
    fontSize: 34, 
    fontWeight: '900', 
    color: '#FFFFFF',
    letterSpacing: 1.5,
    marginBottom: 8
  },
  subtitle: { 
    fontSize: 18, 
    color: '#94A3B8', // Slate gray for secondary info
    marginBottom: 60,
    fontWeight: '500',
    letterSpacing: 0.5
  },
  
  // The Main SOS Button
  buttonContainer: { 
    width: '85%', 
    maxWidth: 400, // Keeps it from getting too wide on large screens
  },
  sosButton: {
    backgroundColor: '#DC2626', // High-contrast danger red
    paddingVertical: 24,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC2626',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
    borderWidth: 2,
    borderColor: '#EF4444' // Slightly lighter red border for depth
  },
  sosButtonDisabled: {
    backgroundColor: '#475569', // Muted slate when syncing
    borderColor: '#334155',
    shadowOpacity: 0
  },
  sosButtonText: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 2
  },

  // --- CRASH SEQUENCE UI ---
  crashTitle: { 
    fontSize: 42, 
    fontWeight: '900', 
    color: '#FFFFFF', 
    textAlign: 'center',
    letterSpacing: 2
  },
  crashSubtitle: { 
    fontSize: 22, 
    color: '#FECACA', // Light red for secondary crash text
    marginTop: 15,
    fontWeight: '600'
  },
  timerText: { 
    fontSize: 120, 
    fontWeight: '900', 
    color: '#FFFFFF', 
    marginVertical: 30,
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 10 },
    textShadowRadius: 20
  },
  cancelButton: { 
    backgroundColor: '#FFFFFF', 
    paddingVertical: 24, 
    paddingHorizontal: 40,
    borderRadius: 16, 
    marginTop: 20, 
    width: '85%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8
  },
  cancelButtonText: { 
    color: '#DC2626', 
    fontSize: 22, 
    fontWeight: '900', 
    textAlign: 'center',
    letterSpacing: 1
  },

  // --- ONBOARDING MODAL ---
  modalContainer: { 
    flex: 1, 
    padding: 30, 
    justifyContent: 'center', 
    backgroundColor: '#0F172A' 
  },
  headerTitle: { 
    fontSize: 36, 
    fontWeight: '900', 
    color: '#DC2626', 
    marginBottom: 10 
  },
  subText: { 
    fontSize: 18, 
    color: '#94A3B8', 
    marginBottom: 40,
    lineHeight: 24
  },
  input: { 
    backgroundColor: '#1E293B', // Slightly lighter than background
    borderWidth: 1, 
    borderColor: '#334155', 
    padding: 18, 
    borderRadius: 12, 
    marginBottom: 20, 
    fontSize: 18,
    color: '#FFFFFF'
  },
  saveButton: { 
    backgroundColor: '#DC2626', 
    padding: 20, 
    borderRadius: 12, 
    alignItems: 'center', 
    marginTop: 20 
  },
  saveButtonText: { 
    color: '#FFFFFF', 
    fontWeight: '900', 
    fontSize: 20,
    letterSpacing: 1
  }
});