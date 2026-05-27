import { StyleSheet, Text, View, Button, Alert, TouchableOpacity, FlatList, ActivityIndicator, Modal, TextInput } from 'react-native';
import React, { useEffect, useState, useRef } from 'react';
import { Accelerometer } from 'expo-sensors';
import * as Location from 'expo-location'; 


// Import our new Smart Vault Engine & Profile
import { initializeSmartVault, syncAreaIfNeeded, getLocalEmergencyServices } from '../services/DatabaseService'; 
import { sendEmergencySMS } from '../services/SmsService'; 
import { saveUserProfile, getUserProfile } from '../services/ProfileService'; // <-- Re-added Profile Service

export default function HomeScreen() {
  const [isSyncing, setIsSyncing] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [nearbyServices, setNearbyServices] = useState<any[]>([]); 
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Profile State Re-added
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [profile, setProfile] = useState({ name: '', bloodType: '', vehicleId: '', emergencyPhone: '' });

  // ==========================================
  // 1. THE SILENT CO-PILOT (Boot Sequence)
  // ==========================================
  useEffect(() => {
    const bootSystem = async () => {
      try {
        console.log("Booting Smart Vault...");
        await initializeSmartVault();

        // CHECK PROFILE FIRST
        const existingProfile = await getUserProfile();
        if (!existingProfile || !existingProfile.name) { 
            setShowOnboarding(true); 
        } else {
            setProfile(existingProfile);
        }

        console.log("Requesting GPS Permissions...");
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert("Permission Denied", "RoadSOS needs GPS to build your safety net.");
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
  // 1.5. THE ROLLING CACHE (Active Driving Tracker)
  // ==========================================
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
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;

      locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 1000, // Check every 1km of driving
        },
        async (location) => {
          const { latitude, longitude } = location.coords;
          if (!lastSyncedLocation) {
            lastSyncedLocation = { latitude, longitude };
            return;
          }

          const distanceDriven = getDistanceFromLatLonInKm(
            lastSyncedLocation.latitude, lastSyncedLocation.longitude,
            latitude, longitude
          );

          // If driven > 5km, trigger the rolling cache background sync
          if (distanceDriven >= 5) {
            console.log(`🚙 Traveled ${distanceDriven.toFixed(1)}km. Updating Smart Vault...`);
            lastSyncedLocation = { latitude, longitude };
            await syncAreaIfNeeded(latitude, longitude);
            
            // Refresh UI with new data seamlessly
            const newLocalData = await getLocalEmergencyServices(latitude, longitude);
            setNearbyServices(newLocalData);
          }
        }
      );
    };

    startDrivingTracker();
    return () => { if (locationSubscription) locationSubscription.remove(); };
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
      console.log("Acquiring Live GPS Target...");
      
      // 1. MUST use 'Balanced' or 'Low' so it doesn't hang infinitely indoors!
      const location = await Location.getCurrentPositionAsync({ 
          accuracy: Location.Accuracy.Balanced 
      });
      
      console.log("Deploying SMS Payload...");
      
      // 2. Assuming 'nearbyServices' and 'profile' are in your state. 
      // If profile doesn't exist on this branch yet, pass 'null' instead of 'profile'.
      const smsSuccess = await sendEmergencySMS(
          location.coords, 
          nearbyServices, 
          profile, // Change to 'null' if you haven't rebuilt the profile state yet
          ['112']
      );
      
      if (!smsSuccess) {
          Alert.alert("Hardware Notice", "Failed to open SMS. Are you testing on an emulator?");
      }
    } catch (error: any) {
      console.error("SOS Failure:", error);
      Alert.alert("SOS Execution Failure", error.message);
    }
  };

  const handleSaveProfile = async () => {
    console.log("Attempting to arm system with profile:", profile);

    // 1. THE NATIVE ALERT FIX: Android will actually show this now!
    if (!profile.name || !profile.bloodType || !profile.emergencyPhone) {
        Alert.alert(
          "Missing Vitals", 
          "Please fill out your Name, Blood Type, and Emergency Phone to arm the SOS engine."
        );
        return;
    }

    try {
      // 2. Wrap the storage call in a try/catch to log any hidden hardware crashes
      const success = await saveUserProfile(profile);
      
      if (success !== false) {
        console.log("✅ Profile locked into Vault.");
        setShowOnboarding(false); // Close the modal
      } else {
        Alert.alert("Storage Error", "Failed to save profile to phone memory.");
      }
    } catch (error: any) {
      console.error("Critical Save Error:", error);
      Alert.alert("System Error", error.message);
    }
  };

  // ==========================================
  // UI RENDERING
  // ==========================================
  
  return (
    <View style={{ flex: 1, backgroundColor: '#F8F9FA' }}>
      
      {/* 1. THE VITAL ONBOARDING LOCK SCREEN */}
      <Modal visible={showOnboarding} animationType="slide" transparent={false}>
        <View style={styles.modalContainer}>
          <Text style={styles.headerTitle}>RoadSOS Setup</Text>
          <Text style={styles.subText}>Enter your medical vitals to arm the SOS engine.</Text>
          
          <TextInput style={styles.input} placeholder="Full Name" placeholderTextColor="#666" value={profile.name} onChangeText={(text) => setProfile({...profile, name: text})} />
          <TextInput style={styles.input} placeholder="Blood Type (e.g., O-, A+)" placeholderTextColor="#666" value={profile.bloodType} onChangeText={(text) => setProfile({...profile, bloodType: text})} />
          <TextInput style={styles.input} placeholder="Vehicle Registration (e.g., BR01)" placeholderTextColor="#666" value={profile.vehicleId} onChangeText={(text) => setProfile({...profile, vehicleId: text})} />
          <TextInput style={styles.input} placeholder="Family Emergency Phone" keyboardType="phone-pad" placeholderTextColor="#666" value={profile.emergencyPhone} onChangeText={(text) => setProfile({...profile, emergencyPhone: text})} />

          <TouchableOpacity style={styles.saveButton} onPress={handleSaveProfile}>
            <Text style={styles.saveButtonText}>ARM SYSTEM</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* 2. CONDITIONAL BACKGROUND SCREENS */}
      {countdown !== null ? (
        
        // --- CRASH OVERRIDE UI ---
        <View style={[styles.container, { backgroundColor: '#D32F2F', justifyContent: 'center' }]}>
          <Text style={styles.crashTitle}>CRASH DETECTED</Text>
          <Text style={styles.crashSubtitle}>Auto-dispatching SOS in:</Text>
          <Text style={styles.timerText}>{countdown}s</Text>
          <TouchableOpacity style={styles.cancelButton} onPress={cancelCrashSequence}>
            <Text style={styles.cancelButtonText}>I AM SAFE (CANCEL)</Text>
          </TouchableOpacity>
        </View>

      ) : isSyncing ? (

        // --- SATELLITE SEARCHING UI ---
        <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
          <ActivityIndicator size="large" color="#D32F2F" />
          <Text style={[styles.title, {marginTop: 20}]}>Securing Area...</Text>
          <Text style={styles.subtitle}>Switching to satellite GPS & verifying offline vault.</Text>
        </View>

      ) : (

        // --- NORMAL UI WITH DATA CARDS ---
        <>
          <View style={styles.container}>
            <View style={styles.header}>
              <Text style={styles.title}>RoadSOS: Active</Text>
              <Text style={styles.subtitle}>Driver: {profile.name || 'Unknown'} • Vault Ready</Text>
              
              <TouchableOpacity onPress={() => setShowOnboarding(true)} style={{ marginTop: 8, padding: 10 }}>
                <Text style={{ color: '#007AFF', fontWeight: 'bold' }}>⚙️ Edit Vitals Profile</Text>
              </TouchableOpacity>
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
          </View>
          
          {/* THE FIX: Button is now completely completely separated from the container padding! */}
          <View style={styles.floatingButtonContainer}>
            <TouchableOpacity 
              style={styles.floatingButton} 
              onPress={() => {
                console.log("🚨 SOS BUTTON PHYSICALLY TAPPED!");
                triggerSOS();
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.floatingButtonText}>🚨 MANUAL SOS OVERRIDE 🚨</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

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
  
  listContainer: { flex: 1, width: '100%', paddingBottom: 130 }, 

  // THE UPGRADED FLOATING BUTTON STYLES
  floatingButtonContainer: { 
    position: 'absolute', 
    bottom: 110, 
    width: '100%', 
    alignSelf: 'center', 
    paddingHorizontal: 20,
    zIndex: 9999, // <-- CRITICAL: Forces Android to make this clickable over the list!
    elevation: 20
  },
  floatingButton: {
    backgroundColor: '#D32F2F',
    paddingVertical: 30,
    borderRadius: 30,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 10
  },
  floatingButtonText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 1
  },

  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  emptyText: { color: '#888', fontStyle: 'italic', textAlign: 'center', marginTop: 20 },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 5, elevation: 2 },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#222' },
  cardType: { fontSize: 12, color: '#D32F2F', marginTop: 4, fontWeight: '700' },
  buttonContainer: { width: '100%', paddingBottom: 40, paddingTop: 10 },
  
  crashTitle: { fontSize: 36, fontWeight: '900', color: '#FFF', textAlign: 'center' },
  crashSubtitle: { fontSize: 20, color: '#FFF', marginTop: 10, textAlign: 'center' },
  timerText: { fontSize: 100, fontWeight: 'bold', color: '#FFF', textAlign: 'center', marginVertical: 20 },
  cancelButton: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, marginTop: 40, alignSelf: 'center', width: '90%' },
  cancelButtonText: { color: '#D32F2F', fontSize: 20, fontWeight: '900', textAlign: 'center' },

  // Onboarding UI Styles
  modalContainer: { flex: 1, padding: 30, justifyContent: 'center', backgroundColor: '#111' },
  headerTitle: { fontSize: 32, fontWeight: 'bold', color: '#D32F2F', marginBottom: 10 },
  subText: { fontSize: 16, color: '#AAA', marginBottom: 30 },
  input: { backgroundColor: '#222', color: '#FFF', borderWidth: 1, borderColor: '#333', padding: 15, borderRadius: 8, marginBottom: 15, fontSize: 16 },
  saveButton: { backgroundColor: '#D32F2F', padding: 18, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  saveButtonText: { color: 'white', fontWeight: 'bold', fontSize: 18 }
});