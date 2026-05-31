import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Battery from 'expo-battery';
import * as Brightness from 'expo-brightness';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  DeviceEventEmitter,
  FlatList,
  Linking,
  Modal,
  PanResponder,
  Platform,
  StatusBar,
  StyleSheet, Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View
} from 'react-native';

// Services & Hooks
import { useLocationWatcher } from '../hooks/useLocationWatcher';
import { getLocalEmergencyServices, initializeSmartVault, syncAreaIfNeeded } from '../services/DatabaseService';
import { startNavigation } from '../services/LocationService';
import { getUserProfile, saveUserProfile } from '../services/ProfileService';
import { sendEmergencySMS } from '../services/SmsService';

// ─── TYPESCRIPT INTERFACES ────────────────────────────────────────────────────
interface UserProfile {
  name: string;
  bloodType: string;
  vehicleId: string;
  contact1: string;
  contact2: string;
  contact3: string;
}

const COLORS = {
  danger:       '#FF3B30', // Apple Standard Red
  dangerDark:   '#4A0005',
  amber:        '#FF9F0A',
  safe:         '#32D74B',
  bg:           '#000000', // True OLED Black
  surface:      '#1C1C1E', // Flat Dark Grey
  surfaceRaised:'#2C2C2E',
  surfaceBorder:'#38383A',
  textPrimary:  '#FFFFFF',
  textSecondary:'#EBEBF5',
  textMuted:    '#8E8E93',
  navBlue:      '#0A84FF',
};

const FONT = { 
  black:   '900' as const, 
  bold:    '700' as const, 
  semi:    '600' as const, 
  medium:  '500' as const, 
  regular: '400' as const 
};

const RADIUS = { sm: 6, md: 10, lg: 16, xl: 20, pill: 999 };
const SHADOW_DANGER = { shadowColor: COLORS.danger, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.45, shadowRadius: 16, elevation: 12 };
const SHADOW_AMBER = { shadowColor: COLORS.amber, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 14, elevation: 10 };
const SHADOW_SOFT = { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 };

// ─── Small reusable components ────────────────────────────────────────────────
const Divider = () => <View style={{ height: 1, backgroundColor: COLORS.surfaceBorder, marginVertical: 10 }} />;
const StatusBadge = ({ label, color }: { label: string; color: string }) => (
  <View style={[ui.badge, { borderColor: color, backgroundColor: color + '22' }]}>
    <View style={[ui.badgeDot, { backgroundColor: color }]} />
    <Text style={[ui.badgeText, { color }]}>{label}</Text>
  </View>
);

// ─── Main Component ───────────────────────────────────────────────────────────
export default function HomeScreen() {
  const [isVaultReady, setIsVaultReady]     = useState(false);
  const [showAllServices, setShowAllServices] = useState(false);
  const [isSyncing, setIsSyncing]           = useState(true);
  const [countdown, setCountdown]           = useState<number | null>(null);
  const [nearbyServices, setNearbyServices] = useState<any[]>([]);
  
  const timerRef = useRef<NodeJS.Timeout | number | null>(null);
  const speedBuffer = useRef<number[]>([]);

  const [isEmergencyMode, setIsEmergencyMode]   = useState(false);
  const [showRoleSelector, setShowRoleSelector] = useState(false);
  const [emergencyRole, setEmergencyRole]       = useState<'USER' | 'BYSTANDER' | null>(null);
  const [activeTab, setActiveTab]   = useState('ALL');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [profile, setProfile] = useState<UserProfile>({
    name: '', bloodType: '', vehicleId: '',
    contact1: '', contact2: '', contact3: ''
  });

  // Safe State Refs for Crash Closure Bug
  const profileRef = useRef<UserProfile>(profile);
  const nearbyRef = useRef<any[]>(nearbyServices);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { nearbyRef.current = nearbyServices; }, [nearbyServices]);

  useLocationWatcher(isVaultReady);

  // ==========================================
  // SMART BOOT CHECK (SPEED / DAILY REMINDER)
  // ==========================================
  useEffect(() => {
    const runSmartBootCheck = async () => {
      try {
        if (Platform.OS === 'web') return; // Skip hardware checks on web

        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;

        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        
        const speedMetersPerSec = location.coords.speed || 0;
        const speedKmh = speedMetersPerSec * 3.6;

        // URGENT: Moving fast
        if (speedKmh > 15) {
          Alert.alert(
            "🚗 Motion Detected!",
            "It looks like you are traveling. Please ensure RoadSOS is actively running on your screen to keep crash detection armed.",
            [{ text: "I will keep it on" }]
          );
          return; 
        }

        // GENTLE: Daily standard reminder
        const today = new Date().toDateString();
        const lastReminderDate = await AsyncStorage.getItem('@last_drive_reminder');

        if (lastReminderDate !== today) {
          Alert.alert(
            "Stay Safe Today",
            "Don't forget to keep RoadSOS open when you start your journey for automatic crash detection!",
            [{ text: "Got it" }]
          );
          await AsyncStorage.setItem('@last_drive_reminder', today);
        }

      } catch (error) {
        console.log("Smart Boot Check skipped (GPS unavailable or timeout).", error);
      }
    };

    // Delay slightly so it doesn't conflict with the main vault sync UI
    setTimeout(() => {
      runSmartBootCheck();
    }, 1500);
  }, []);

  // ==========================================
  // HARDWARE OVERRIDE: SCREEN TIMEOUT & BRIGHTNESS
  // ==========================================
  const originalBrightnessRef = useRef<number | null>(null);

  useEffect(() => {
    const manageHardware = async () => {
      // 1. ALWAYS keep the screen awake while the app is open
      activateKeepAwakeAsync();

      if (isSyncing || countdown !== null || isEmergencyMode || showRoleSelector) {
        // 2. Force Brightness to 100% during an active emergency
        const { status } = await Brightness.requestPermissionsAsync();
        if (status === 'granted') {
          const currentBrightness = await Brightness.getBrightnessAsync();
          if (originalBrightnessRef.current === null) {
             originalBrightnessRef.current = currentBrightness;
          }
          await Brightness.setBrightnessAsync(1); 
        }
      } else {
        // 3. Revert brightness to normal when NOT in an emergency
        // Screen remains awake because of step 1!
        if (originalBrightnessRef.current !== null) {
          const { status } = await Brightness.requestPermissionsAsync();
          if (status === 'granted') {
             await Brightness.setBrightnessAsync(originalBrightnessRef.current);
          }
          originalBrightnessRef.current = null; 
        }
      }
    };

    manageHardware();
  }, [isSyncing, countdown, isEmergencyMode, showRoleSelector]);

  // ==========================================
  // LOW BATTERY PROTOCOL
  // ==========================================
  const [lowBatteryFired, setLowBatteryFired] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const checkBattery = async (level: number) => {
      if (level > 0 && level <= 0.10 && !lowBatteryFired && isVaultReady) {
        setLowBatteryFired(true);
        Alert.alert("Critical Battery", "Battery below 10%. Dispatching last known location to contacts.");
        triggerSOS(true);
      }
    };
    Battery.getBatteryLevelAsync().then(checkBattery);
    const sub = Battery.addBatteryLevelListener(({ batteryLevel }) => checkBattery(batteryLevel));
    return () => sub.remove();
  }, [lowBatteryFired, isVaultReady]);

  // ==========================================
  // OFFLINE NETWORK QUEUE
  // ==========================================
  useEffect(() => {
    const checkQueue = async () => {
      const pendingSOS = await AsyncStorage.getItem('PENDING_SOS');
      if (pendingSOS) {
        const state = await NetInfo.fetch();
        if (state.isConnected) {
          console.log("📶 Network Restored! Pushing queued SOS.");
          await AsyncStorage.removeItem('PENDING_SOS');
          Alert.alert("Network Restored", "Dispatching your queued SOS message now.");
          triggerSOS();
        }
      }
    };
    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.isConnected) checkQueue();
    });
    return () => unsubscribe();
  }, []);

  // ==========================================
  // SPEED TRACKER (Velocity-Gated Memory)
  // ==========================================
  useEffect(() => {
    let speedSub: { remove: () => void } | null = null;
    const startSpeedTracker = async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;
      speedSub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
        (location) => {
          const speedKmH = (location.coords.speed || 0) * 3.6;
          speedBuffer.current.push(speedKmH);
          if (speedBuffer.current.length > 5) speedBuffer.current.shift();
        }
      );
    };
    startSpeedTracker();
    return () => { if (speedSub) speedSub.remove(); };
  }, []);

  // ==========================================
  // SLIDER LOGIC
  // ==========================================
  const pan = useRef(new Animated.ValueXY()).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: pan.x }], { useNativeDriver: false }),
      onPanResponderRelease: (e, gesture) => {
        if (gesture.dx > 120) {
          Vibration.vibrate(50); 
          Animated.spring(pan, { toValue: { x: 250, y: 0 }, useNativeDriver: false }).start();
          setTimeout(() => setShowRoleSelector(true), 200);
        } else {
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
        }
      }
    })
  ).current;

  const closeEmergencyMode = () => {
    setIsEmergencyMode(false);
    setEmergencyRole(null);
    Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
  };

  // ==========================================
  // BOOT SEQUENCE
  // ==========================================
  useEffect(() => {
    const bootSystem = async () => {
      try {
        if (Platform.OS === 'web') {
          console.log("🌐 Web Environment Detected: Bypassing Native Smart Vault.");
          
          const existingProfile = await getUserProfile();
          if (!existingProfile || !existingProfile.name) {
            setShowOnboarding(true);
          } else {
            setProfile(existingProfile);
          }
          
          setNearbyServices([
            { id: '1', type: 'hospital', name: 'Web Test Hospital', distance: 1.2 },
            { id: '2', type: 'police', name: 'Web Test Police', distance: 2.5 },
            { id: '3', type: 'repair', name: 'Web Test Mechanic', distance: 0.8 },
            { id: '4', type: 'fuel', name: 'Web Test Petrol Pump', distance: 3.1 }
          ]);
          
          setIsVaultReady(true);
          return; 
        }

        await initializeSmartVault();
        const existingProfile = await getUserProfile();
        if (!existingProfile || !existingProfile.name) {
          setShowOnboarding(true);
        } else {
          setProfile(existingProfile);
        }
        
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert("Permission Denied", "GPS is required.");
          setIsSyncing(false);
          return;
        }
        
        const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        await syncAreaIfNeeded(location.coords.latitude, location.coords.longitude);
        const localData = await getLocalEmergencyServices(location.coords.latitude, location.coords.longitude);
        
        setNearbyServices(localData);
        setIsVaultReady(true);
        
      } catch (error) {
        console.log("Boot error:", error);
      } finally {
        setIsSyncing(false);
      }
    };
    
    bootSystem();
  }, []);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('VaultUpdated', async () => {
      try {
        const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const newLocalData = await getLocalEmergencyServices(location.coords.latitude, location.coords.longitude);
        setNearbyServices(newLocalData);
      } catch (error) {
        console.error("Failed UI refresh", error);
      }
    });
    return () => subscription.remove();
  }, []);

  // ==========================================
  // CRASH DETECTOR
  // ==========================================
  useEffect(() => {
    if (Platform.OS === 'web') return;

    Accelerometer.setUpdateInterval(200);
    const subscription = Accelerometer.addListener(data => {
      if (timerRef.current) return;
      const totalGForce = Math.sqrt(data.x ** 2 + data.y ** 2 + data.z ** 2);
      
      if (totalGForce > 4.0) {
        const wasDrivingFast = speedBuffer.current.some(speed => speed > 30);
        if (wasDrivingFast) triggerCrashSequence();
      }
    });
    
    return () => {
      if (subscription && subscription.remove) {
        subscription.remove();
      }
    };
  }, []);

  // ==========================================
  // CORE FUNCTIONS
  // ==========================================
  const triggerCrashSequence = () => {
    Vibration.vibrate([0, 500, 200, 500, 200, 1000]); 
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
      clearInterval(timerRef.current as any);
      timerRef.current = null;
      setCountdown(null);
    }
  };

  const triggerSOS = async (isBatteryAlert = false) => {
    try {
      console.log("🚨 Compiling SMS Payload...");
      
      const networkState = await NetInfo.fetch();
      if (!networkState.isConnected) {
        await AsyncStorage.setItem('PENDING_SOS', JSON.stringify({ queuedAt: Date.now() }));
        Alert.alert("Dead Zone Detected", "Offline. Signal queued for next cell tower.");
        return;
      }
      
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      
      const activeProfile = profileRef.current;
      const activeNearby = nearbyRef.current;
      const rawNumbers = ['112', activeProfile.contact1, activeProfile.contact2, activeProfile.contact3];
      
      const targetNumbers = rawNumbers.filter(num => num && num.trim() !== '');

      const smsSuccess = await sendEmergencySMS(location.coords, activeNearby, activeProfile as any, targetNumbers as any);
      
      if (!smsSuccess) {
        Alert.alert(
          "Hardware Blocked", 
          "Your phone refused to open the native SMS app. Ensure you are on a physical device, not an emulator!"
        );
      }
    } catch (error: any) {
      console.error("SMS Error:", error);
      Alert.alert("SOS Execution Failure", error.message);
    }
  };

  const handleSaveProfile = async () => {
    if (!profile.name || !profile.bloodType) {
      Alert.alert("Missing Data", "Please fill out at least your Name and Blood Type.");
      return;
    }
    try {
      await saveUserProfile(profile);
      setShowOnboarding(false);
    } catch (error: any) {
      Alert.alert("System Error", error.message);
    }
  };

  const filteredServices = React.useMemo(() => {
    let result: any[] = [];
    
    if (activeTab === 'ALL') {
      result = nearbyServices;
    } else if (activeTab === 'MEDICAL') {
      result = nearbyServices.filter(item => item.type.includes('hospital') || item.type.includes('clinic') || item.type.includes('pharmacy'));
    } else if (activeTab === 'POLICE') {
      result = nearbyServices.filter(item => item.type.includes('police') || item.type.includes('fire'));
    } else if (activeTab === 'AUTO') {
      result = nearbyServices.filter(item => item.type.includes('repair') || item.type.includes('fuel'));
    }

    if (!showAllServices) {
      if (activeTab === 'ALL') {
        const meds = result.filter(i => i.type.includes('hospital') || i.type.includes('clinic') || i.type.includes('pharmacy')).slice(0, 3);
        const pols = result.filter(i => i.type.includes('police') || i.type.includes('fire')).slice(0, 3);
        const autos = result.filter(i => i.type.includes('repair') || i.type.includes('fuel')).slice(0, 3);
        
        result = [...meds, ...pols, ...autos].sort((a, b) => a.distance - b.distance);
      } else {
        result = result.slice(0, 3);
      }
    }
    return result;
  }, [nearbyServices, activeTab, showAllServices]);

  const getServiceIcon = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('hospital') || t.includes('clinic') || t.includes('pharmacy')) return '🏥';
    if (t.includes('police')) return '🚓';
    if (t.includes('fire')) return '🚒';
    if (t.includes('repair')) return '🔧';
    if (t.includes('fuel')) return '⛽';
    return '🚨';
  };

  const isBystander = emergencyRole === 'BYSTANDER';
  const accentColor = isBystander ? COLORS.amber : COLORS.danger;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      {/* MODAL 1 · ONBOARDING */}
      <Modal visible={showOnboarding} animationType="slide" transparent={false}>
        <View style={styles.onboardingRoot}>
          <View style={styles.onboardingHeader}>
            <View style={styles.onboardingBadge}>
              <Text style={styles.onboardingBadgeText}>SETUP</Text>
            </View>
            <Text style={styles.onboardingTitle}>RoadSOS</Text>
            <Text style={styles.onboardingSubtitle}>Configure your Medical ID & Emergency Contacts</Text>
          </View>

          <View style={styles.onboardingForm}>
            <Text style={styles.formGroupLabel}>IDENTITY</Text>
            <TextInput style={styles.inputField} placeholder="Full Name" placeholderTextColor={COLORS.textMuted} value={profile.name} onChangeText={(text) => setProfile({ ...profile, name: text })} />
            <View style={styles.inputRow}>
              <TextInput style={[styles.inputField, styles.inputHalf]} placeholder="Blood Type (e.g. O−)" placeholderTextColor={COLORS.textMuted} value={profile.bloodType} onChangeText={(text) => setProfile({ ...profile, bloodType: text })} />
              <TextInput style={[styles.inputField, styles.inputHalf]} placeholder="Vehicle Reg" placeholderTextColor={COLORS.textMuted} value={profile.vehicleId} onChangeText={(text) => setProfile({ ...profile, vehicleId: text })} />
            </View>

            <Text style={[styles.formGroupLabel, { marginTop: 20 }]}>EMERGENCY CONTACTS</Text>
            {(['contact1', 'contact2', 'contact3'] as const).map((key, i) => (
              <TextInput
                key={key}
                style={styles.inputField}
                placeholder={`Contact ${i + 1} — Phone Number`}
                placeholderTextColor={COLORS.textMuted}
                keyboardType="phone-pad"
                value={profile[key]}
                onChangeText={(text) => setProfile({ ...profile, [key]: text })}
              />
            ))}
          </View>

          <TouchableOpacity style={styles.saveBtn} onPress={handleSaveProfile} activeOpacity={0.85}>
            <Text style={styles.saveBtnText}>ARM THE SYSTEM  →</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* MODAL 2 · ROLE SELECTOR */}
      <Modal visible={showRoleSelector} transparent animationType="fade">
        <View style={styles.roleOverlay}>
          <View style={styles.roleSheet}>
            <Text style={styles.roleSheetEyebrow}>EMERGENCY ACTIVATED</Text>
            <Text style={styles.roleSheetTitle}>Who needs help?</Text>
            <Text style={styles.roleSheetSub}>Your choice determines which alerts are sent</Text>

            <TouchableOpacity style={styles.roleCardDanger} onPress={() => { setEmergencyRole('USER'); setShowRoleSelector(false); setIsEmergencyMode(true); }} activeOpacity={0.88}>
              <Text style={styles.roleCardIcon}>🆘</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.roleCardTitle}>I Need Help</Text>
                <Text style={styles.roleCardSub}>Dispatches SMS + GPS to your family</Text>
              </View>
              <Text style={styles.roleCardArrow}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.roleCardAmber} onPress={() => { setEmergencyRole('BYSTANDER'); setShowRoleSelector(false); setIsEmergencyMode(true); }} activeOpacity={0.88}>
              <Text style={styles.roleCardIcon}>🤝</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.roleCardTitle, { color: COLORS.amber }]}>I'm Helping Someone</Text>
                <Text style={styles.roleCardSub}>Does NOT message your family</Text>
              </View>
              <Text style={[styles.roleCardArrow, { color: COLORS.amber }]}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.roleCancelBtn} onPress={() => { setShowRoleSelector(false); Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start(); }}>
              <Text style={styles.roleCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* SCREEN 3 · CRASH DETECTED */}
      {countdown !== null ? (
        <View style={styles.crashScreen}>
          <View style={styles.crashPulseRing} />
          <Text style={styles.crashEyebrow}>⚠  IMPACT DETECTED</Text>
          <Text style={styles.crashTitle}>CRASH{'\n'}DETECTED</Text>
          <Text style={styles.crashSub}>Auto-dispatching SOS in</Text>
          <View style={styles.crashTimerBox}>
            <Text style={styles.crashTimer}>{countdown}</Text>
            <Text style={styles.crashTimerUnit}>SEC</Text>
          </View>
          <TouchableOpacity style={styles.crashCancelBtn} onPress={cancelCrashSequence} activeOpacity={0.88}>
            <Text style={styles.crashCancelText}>I AM SAFE — CANCEL</Text>
          </TouchableOpacity>
        </View>
      ) : isSyncing ? (
        <View style={styles.syncScreen}>
          <ActivityIndicator size="large" color={COLORS.danger} />
          <Text style={styles.syncTitle}>SECURING AREA</Text>
          <Text style={styles.syncSub}>Initialising Smart Vault · Syncing emergency services…</Text>
        </View>
      ) : isEmergencyMode ? (
        <View style={styles.emergencyRoot}>
          
          <View style={[styles.emergencyTopBar, { borderBottomColor: COLORS.surfaceBorder }]}>
            
            <TouchableOpacity onPress={closeEmergencyMode} style={styles.exitBtn} activeOpacity={0.75}>
              <Text style={[styles.exitBtnText, { fontSize: 15, fontWeight: FONT.black }]}>✕</Text>
            </TouchableOpacity>

            <View style={[styles.modeBadge, { backgroundColor: COLORS.surface, borderColor: accentColor }]}>
              <View style={[styles.modeBadgeDot, { backgroundColor: accentColor }]} />
              <Text style={[styles.modeBadgeText, { color: accentColor }]}>{isBystander ? 'BYSTANDER' : 'EMERGENCY'}</Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={styles.miniActionBtn} onPress={() => Linking.openURL('tel:112')} activeOpacity={0.7}>
                <Text style={{ fontSize: 16 }}>📞</Text>
              </TouchableOpacity>

              {emergencyRole === 'USER' && (
                <TouchableOpacity style={[styles.miniActionBtn, { backgroundColor: COLORS.danger, borderColor: COLORS.dangerDark }]} onPress={() => triggerSOS()} activeOpacity={0.7}>
                  <Text style={{ fontSize: 16 }}>💬</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <View style={styles.tabRow}>
            {(['ALL', 'MEDICAL', 'POLICE', 'AUTO'] as const).map((tab) => {
              const tabIcons: Record<string, string> = { ALL: '🗺', MEDICAL: '🏥', POLICE: '🚓', AUTO: '🔧' };
              const active = activeTab === tab;
              return (
                <TouchableOpacity 
                  key={tab} 
                  style={[styles.tabBtn, active && { backgroundColor: COLORS.surfaceRaised, borderColor: accentColor }]} 
                  onPress={() => { setActiveTab(tab); setShowAllServices(false); }} 
                  activeOpacity={0.8}
                >
                  <Text style={styles.tabBtnIcon}>{tabIcons[tab]}</Text>
                  <Text style={[styles.tabBtnLabel, active && { color: COLORS.textPrimary }]}>{tab}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <FlatList
            data={filteredServices}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListFooterComponent={
              !showAllServices && filteredServices.length >= 3 ? (
                <TouchableOpacity 
                  style={{ padding: 18, alignItems: 'center', marginTop: 5, backgroundColor: COLORS.surface, borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.surfaceBorder }} 
                  onPress={() => setShowAllServices(true)}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: COLORS.textPrimary, fontWeight: FONT.bold, fontSize: 13, letterSpacing: 1.5 }}>
                    ↓  SHOW ALL {activeTab} SERVICES  ↓
                  </Text>
                </TouchableOpacity>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>📡</Text>
                <Text style={styles.emptyTitle}>No services found</Text>
                <Text style={styles.emptyBody}>No {activeTab} services detected nearby. Try broadening the filter.</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={[styles.serviceCard, { borderLeftWidth: 4, borderLeftColor: accentColor }]}>
                <Text style={styles.serviceIcon}>{getServiceIcon(item.type)}</Text>
                <View style={styles.serviceInfo}>
                  <Text style={styles.serviceName}>{item.name}</Text>
                  <Text style={[styles.serviceType, { color: accentColor }]}>{item.type.toUpperCase()}</Text>
                </View>
                <TouchableOpacity style={[styles.navBtn, { backgroundColor: COLORS.surfaceRaised }]} onPress={() => startNavigation(item.latitude || item.lat, item.longitude || item.lon)} activeOpacity={0.85}>
                  <Text style={styles.navBtnText}>GO  ›</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      ) : (
        <View style={styles.dashRoot}>
          <View style={styles.dashHeader}>
            <View>
              <Text style={styles.appName}>RoadSOS</Text>
              <StatusBadge label="SYSTEM ARMED  ●  VAULT READY" color={COLORS.safe} />
            </View>
            <TouchableOpacity style={styles.editProfileBtn} onPress={() => setShowOnboarding(true)}>
              <Text style={styles.editProfileText}>Edit</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.medCard}>
            <View style={styles.medCardHeader}>
              <Text style={styles.medCardLabel}>MEDICAL ID</Text>
              <View style={styles.bloodTypePill}>
                <Text style={styles.bloodTypeText}>{profile.bloodType || '—'}</Text>
              </View>
            </View>
            <Divider />
            <View style={styles.medRow}>
              <View style={styles.medField}>
                <Text style={styles.medFieldLabel}>DRIVER</Text>
                <Text style={styles.medFieldValue}>{profile.name || 'Not set'}</Text>
              </View>
              <View style={[styles.medField, { alignItems: 'flex-end' }]}>
                <Text style={styles.medFieldLabel}>VEHICLE</Text>
                <Text style={styles.medFieldValue}>{profile.vehicleId || 'N/A'}</Text>
              </View>
            </View>
          </View>

          <View style={styles.contactsCard}>
            <Text style={styles.contactsLabel}>EMERGENCY CONTACTS</Text>
            {[profile.contact1, profile.contact2, profile.contact3].map((num, i) => (
              <View key={i} style={styles.contactRow}>
                <View style={styles.contactIndex}>
                  <Text style={styles.contactIndexText}>{i + 1}</Text>
                </View>
                <Text style={[styles.contactNum, !num && { color: COLORS.textMuted, fontStyle: 'italic' }]}>{num || 'Not configured'}</Text>
              </View>
            ))}
          </View>

          {nearbyServices.length > 0 && (
            <View style={styles.nearbyStrip}>
              <Text style={styles.nearbyStripText}>📡  {nearbyServices.length} offline services ready</Text>
            </View>
          )}

          <View style={styles.sliderWrapper}>
            <View style={styles.sliderTrack}>
              <Text style={styles.sliderHint} numberOfLines={1} adjustsFontSizeToFit>SWIPE TO SOS  »</Text>
              <Animated.View {...panResponder.panHandlers} style={[styles.sliderKnob, { transform: [{ translateX: pan.x }] }]}>
                <Text style={styles.sliderKnobText}>»</Text>
              </Animated.View>
            </View>
            <Text style={styles.sliderCaption}>Slide right for Emergency Mode</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// Minimalist UI requires NO shadows. We rely entirely on contrast and thin borders.
const ui = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start', marginTop: 6 },
  badgeDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  badgeText: { fontSize: 10, fontWeight: FONT.bold, letterSpacing: 1 },
});

// ─── Main Stylesheet ──────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  
  // Onboarding Screen
  onboardingRoot: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 24, paddingTop: Platform.OS === 'ios' ? 70 : 50, paddingBottom: 40 },
  onboardingHeader: { marginBottom: 32 },
  onboardingBadge: { backgroundColor: COLORS.surfaceRaised, borderRadius: RADIUS.pill, paddingHorizontal: 12, paddingVertical: 5, alignSelf: 'flex-start', marginBottom: 14 },
  onboardingBadgeText: { color: COLORS.textPrimary, fontSize: 10, fontWeight: FONT.bold, letterSpacing: 2 },
  onboardingTitle: { fontSize: 40, fontWeight: FONT.black, color: COLORS.textPrimary, letterSpacing: -1 },
  onboardingSubtitle: { fontSize: 15, color: COLORS.textMuted, marginTop: 8, lineHeight: 22 },
  onboardingForm: { flex: 1 },
  formGroupLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 10 },
  inputField: { backgroundColor: COLORS.surface, color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.surfaceBorder, borderRadius: RADIUS.md, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, marginBottom: 10 },
  inputRow: { flexDirection: 'row', gap: 10 },
  inputHalf: { flex: 1 },
  saveBtn: { backgroundColor: COLORS.danger, borderRadius: RADIUS.pill, paddingVertical: 18, alignItems: 'center' },
  saveBtnText: { color: COLORS.textPrimary, fontSize: 16, fontWeight: FONT.black, letterSpacing: 1 },
  
  // Role Selector Modal
  roleOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  roleSheet: { backgroundColor: COLORS.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, paddingBottom: 44, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  roleSheetEyebrow: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.danger, letterSpacing: 2, textAlign: 'center', marginBottom: 10 },
  roleSheetTitle: { fontSize: 26, fontWeight: FONT.black, color: COLORS.textPrimary, textAlign: 'center' },
  roleSheetSub: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  roleCardDanger: { backgroundColor: COLORS.dangerDark, borderWidth: 1, borderColor: COLORS.danger, borderRadius: RADIUS.lg, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 14 },
  roleCardAmber: { backgroundColor: '#3A2600', borderWidth: 1, borderColor: COLORS.amber, borderRadius: RADIUS.lg, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  roleCardIcon: { fontSize: 28 },
  roleCardTitle: { fontSize: 17, fontWeight: FONT.bold, color: COLORS.textPrimary },
  roleCardSub: { fontSize: 12, color: COLORS.textSecondary, marginTop: 3 },
  roleCardArrow: { fontSize: 26, color: COLORS.textPrimary, fontWeight: FONT.bold },
  roleCancelBtn: { marginTop: 22, alignItems: 'center', padding: 10 },
  roleCancelText: { color: COLORS.textMuted, fontSize: 15, fontWeight: FONT.medium },
  
  // Crash Detection Screen
  crashScreen: { flex: 1, backgroundColor: COLORS.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
  crashPulseRing: { position: 'absolute', width: 320, height: 320, borderRadius: 160, borderWidth: 4, borderColor: '#FFFFFF33' },
  crashEyebrow: { color: COLORS.textPrimary, fontSize: 13, fontWeight: FONT.bold, letterSpacing: 2, marginBottom: 16 },
  crashTitle: { fontSize: 48, fontWeight: FONT.black, color: COLORS.textPrimary, textAlign: 'center', lineHeight: 50, letterSpacing: -2 },
  crashSub: { color: COLORS.textPrimary, fontSize: 16, marginTop: 24, opacity: 0.8 },
  crashTimerBox: { alignItems: 'center', marginVertical: 12 },
  crashTimer: { fontSize: 120, fontWeight: FONT.black, color: COLORS.textPrimary, lineHeight: 130, letterSpacing: -4 },
  crashTimerUnit: { fontSize: 14, fontWeight: FONT.bold, color: COLORS.textPrimary, letterSpacing: 4, marginTop: -10, opacity: 0.8 },
  crashCancelBtn: { backgroundColor: COLORS.bg, borderRadius: RADIUS.pill, paddingVertical: 20, paddingHorizontal: 40, marginTop: 28, alignSelf: 'stretch', alignItems: 'center' },
  crashCancelText: { color: COLORS.textPrimary, fontSize: 18, fontWeight: FONT.black, letterSpacing: 1 },
  
  // Sync Screen
  syncScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 40 },
  syncTitle: { fontSize: 22, fontWeight: FONT.black, color: COLORS.textPrimary, letterSpacing: 3, marginTop: 8 },
  syncSub: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', lineHeight: 20 },
  
  // Emergency Mode Active
  emergencyRoot: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 40 },
  emergencyTopBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 16, borderBottomWidth: 1 },
  exitBtn: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.surfaceBorder, borderRadius: RADIUS.pill, paddingHorizontal: 14, paddingVertical: 7 },
  exitBtnText: { color: COLORS.textPrimary, fontSize: 13, fontWeight: FONT.semi },
  modeBadge: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 12, paddingVertical: 5 },
  modeBadgeDot: { width: 7, height: 7, borderRadius: 4, marginRight: 7 },
  modeBadgeText: { fontSize: 11, fontWeight: FONT.bold, letterSpacing: 1 },
  tabRow: { flexDirection: 'row', gap: 8, marginTop: 18, marginBottom: 16 },
  tabBtn: { flex: 1, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.surfaceBorder, borderRadius: RADIUS.md, paddingVertical: 10, alignItems: 'center' },
  tabBtnIcon: { fontSize: 16, marginBottom: 3 },
  tabBtnLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 1 },
  listContent: { paddingBottom: 40 },
  miniActionBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.surfaceRaised, borderWidth: 1, borderColor: COLORS.surfaceBorder, alignItems: 'center', justifyContent: 'center' },
  serviceCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.md, padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  serviceIcon: { fontSize: 22 },
  serviceInfo: { flex: 1 },
  serviceName: { fontSize: 15, fontWeight: FONT.bold, color: COLORS.textPrimary },
  serviceType: { fontSize: 10, fontWeight: FONT.bold, letterSpacing: 1.2, marginTop: 3 },
  navBtn: { borderRadius: RADIUS.sm, paddingVertical: 10, paddingHorizontal: 16 },
  navBtnText: { color: COLORS.textPrimary, fontWeight: FONT.bold, fontSize: 13 },
  emptyState: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { fontSize: 18, fontWeight: FONT.bold, color: COLORS.textSecondary },
  emptyBody: { fontSize: 14, color: COLORS.textMuted, textAlign: 'center', lineHeight: 20 },
  
  // Dual-Action Footer
  emergencyFooter: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, backgroundColor: COLORS.bg, borderTopWidth: 1, borderTopColor: COLORS.surfaceBorder },
  primaryActionBtn: { borderRadius: RADIUS.pill, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryActionIcon: { fontSize: 20 },
  primaryActionText: { color: COLORS.textPrimary, fontSize: 15, fontWeight: FONT.black, letterSpacing: 1 },
  
  // Main Dashboard
  dashRoot: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 40 },
  dashHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  appName: { fontSize: 36, fontWeight: FONT.black, color: COLORS.textPrimary, letterSpacing: -1 },
  editProfileBtn: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.surfaceBorder, borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4 },
  editProfileText: { color: COLORS.textPrimary, fontSize: 14, fontWeight: FONT.semi },
  medCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 20, marginBottom: 14, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  medCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  medCardLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2 },
  bloodTypePill: { backgroundColor: COLORS.dangerDark, borderWidth: 1, borderColor: COLORS.danger, borderRadius: RADIUS.pill, paddingHorizontal: 14, paddingVertical: 4 },
  bloodTypeText: { color: COLORS.danger, fontSize: 15, fontWeight: FONT.black },
  medRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  medField: { gap: 4 },
  medFieldLabel: { fontSize: 9, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2 },
  medFieldValue: { fontSize: 16, fontWeight: FONT.bold, color: COLORS.textPrimary },
  contactsCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 20, marginBottom: 14, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  contactsLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 14 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  contactIndex: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  contactIndexText: { fontSize: 12, fontWeight: FONT.bold, color: COLORS.textPrimary },
  contactNum: { fontSize: 16, fontWeight: FONT.medium, color: COLORS.textPrimary },
  nearbyStrip: { backgroundColor: COLORS.surface, borderRadius: RADIUS.md, paddingVertical: 10, paddingHorizontal: 16, marginBottom: 20, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  nearbyStripText: { color: COLORS.textMuted, fontSize: 13, fontWeight: FONT.medium },
  
  // Slider UI
  sliderWrapper: { position: 'absolute', bottom: Platform.OS === 'ios' ? 50 : 36, left: 20, right: 20 },
  sliderTrack: { height: 68, backgroundColor: COLORS.surface, borderRadius: RADIUS.pill, justifyContent: 'center', borderWidth: 1, borderColor: COLORS.surfaceBorder, overflow: 'hidden' },
  sliderHint: { position: 'absolute', width: '100%', textAlign: 'center', color: COLORS.textMuted, fontWeight: FONT.bold, fontSize: 14, letterSpacing: 1.5 },
  sliderKnob: { position: 'absolute', left: 4, width: 60, height: 60, backgroundColor: COLORS.danger, borderRadius: RADIUS.pill, justifyContent: 'center', alignItems: 'center' },
  sliderKnobText: { color: COLORS.textPrimary, fontSize: 24, fontWeight: FONT.black },
  sliderCaption: { textAlign: 'center', color: COLORS.textMuted, fontSize: 11, marginTop: 8, letterSpacing: 0.5 },
});