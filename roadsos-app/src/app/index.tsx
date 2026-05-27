import {
  StyleSheet, Text, View, Alert, TouchableOpacity, FlatList,
  ActivityIndicator, Modal, TextInput, DeviceEventEmitter,
  Animated, PanResponder, Linking, StatusBar, Platform, Vibration
} from 'react-native';
import React, { useEffect, useState, useRef } from 'react';
import { Accelerometer } from 'expo-sensors';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Brightness from 'expo-brightness';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Services & Hooks
import { initializeSmartVault, syncAreaIfNeeded, getLocalEmergencyServices } from '../services/DatabaseService';
import { sendEmergencySMS } from '../services/SmsService';
import { saveUserProfile, getUserProfile } from '../services/ProfileService';
import { startNavigation } from '../services/LocationService';
import { useLocationWatcher } from '../hooks/useLocationWatcher';

// ─── TYPESCRIPT INTERFACES ────────────────────────────────────────────────────
interface UserProfile {
  name: string;
  bloodType: string;
  vehicleId: string;
  contact1: string;
  contact2: string;
  contact3: string;
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
const COLORS = {
  danger:       '#FF2D2D',
  dangerDark:   '#C0001A',
  dangerGlow:   'rgba(255,45,45,0.18)',
  dangerMuted:  'rgba(255,45,45,0.10)',
  amber:        '#FF9500',
  amberDark:    '#C46D00',
  amberGlow:    'rgba(255,149,0,0.18)',
  amberMuted:   'rgba(255,149,0,0.10)',
  safe:         '#30D158',
  bg:           '#0A0C10',
  surface:      '#13161C',
  surfaceRaised:'#1C2028',
  surfaceBorder:'#252B36',
  textPrimary:  '#F0F2F5',
  textSecondary:'#8A93A0',
  textMuted:    '#4A5260',
  white:        '#FFFFFF',
  overlay:      'rgba(0,0,0,0.75)',
  navBlue:      '#0A84FF',
};

const FONT = {
  black:   '900' as const,
  bold:    '700' as const,
  semi:    '600' as const,
  medium:  '500' as const,
  regular: '400' as const,
};

const RADIUS = { sm: 8, md: 12, lg: 18, xl: 24, pill: 50 };
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
  const [isSyncing, setIsSyncing]           = useState(true);
  const [countdown, setCountdown]           = useState<number | null>(null);
  const [nearbyServices, setNearbyServices] = useState<any[]>([]);
  
  const timerRef = useRef<NodeJS.Timeout | null>(null);
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
  // HARDWARE OVERRIDE: SCREEN TIMEOUT & BRIGHTNESS
  // ==========================================
  const originalBrightnessRef = useRef<number | null>(null);

  useEffect(() => {
    const manageHardware = async () => {
      if (isSyncing || countdown !== null || isEmergencyMode || showRoleSelector) {
        // 1. Force Screen to Stay Awake
        activateKeepAwakeAsync();
        
        // 2. Force Brightness to 100%
        const { status } = await Brightness.requestPermissionsAsync();
        if (status === 'granted') {
          const currentBrightness = await Brightness.getBrightnessAsync();
          if (originalBrightnessRef.current === null) {
             originalBrightnessRef.current = currentBrightness;
          }
          await Brightness.setBrightnessAsync(1); // 1 = 100%
        }
      } else {
        // 1. Let screen timeout normally again
        deactivateKeepAwake();
        
        // 2. Revert brightness to what it was before the SOS
        if (originalBrightnessRef.current !== null) {
          const { status } = await Brightness.requestPermissionsAsync();
          if (status === 'granted') {
             await Brightness.setBrightnessAsync(originalBrightnessRef.current);
          }
          originalBrightnessRef.current = null; // Clear it out
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
    let speedSub: Location.LocationSubscription | null = null;
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
        // Reduced to 120 so it's easier to slide
        if (gesture.dx > 120) {
          Vibration.vibrate(50); // Haptic feedback on slide
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
    Accelerometer.setUpdateInterval(200);
    const subscription = Accelerometer.addListener(data => {
      if (timerRef.current) return;
      const totalGForce = Math.sqrt(data.x ** 2 + data.y ** 2 + data.z ** 2);
      if (totalGForce > 4.0) {
        const wasDrivingFast = speedBuffer.current.some(speed => speed > 30);
        if (wasDrivingFast) triggerCrashSequence();
      }
    });
    return () => subscription.remove();
  }, []);

  // ==========================================
  // CORE FUNCTIONS
  // ==========================================
  const triggerCrashSequence = () => {
    Vibration.vibrate([0, 500, 200, 500, 200, 1000]); // Aggressive SOS vibration pattern
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

  const triggerSOS = async (isLowBattery = false) => {
    try {
      const networkState = await NetInfo.fetch();
      if (!networkState.isConnected) {
        await AsyncStorage.setItem('PENDING_SOS', JSON.stringify({ queuedAt: Date.now() }));
        Alert.alert("Dead Zone Detected", "Offline. Signal queued for next cell tower.");
        return;
      }
      
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      
      const activeProfile = profileRef.current;
      const activeNearby = nearbyRef.current;

      const targetNumbers = ['112', activeProfile.contact1, activeProfile.contact2, activeProfile.contact3].filter(num => num && num.trim() !== '');
      const smsSuccess = await sendEmergencySMS(location.coords, activeNearby, activeProfile, targetNumbers);
      if (!smsSuccess) Alert.alert("Hardware Notice", "Failed to open SMS.");
    } catch (error: any) {
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

  const filteredServices = nearbyServices.filter(item => {
    if (activeTab === 'ALL') return true;
    if (activeTab === 'HOSPITAL') return item.type.toLowerCase().includes('hospital') || item.type.toLowerCase().includes('clinic');
    if (activeTab === 'POLICE') return item.type.toLowerCase().includes('police');
    return true;
  });

  const getServiceIcon = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('hospital') || t.includes('clinic')) return '🏥';
    if (t.includes('police')) return '🚓';
    if (t.includes('fire')) return '🚒';
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
                <Text style={[styles.roleCardSub, { color: COLORS.textSecondary }]}>Does NOT message your family</Text>
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
          <View style={[styles.emergencyTopBar, { borderBottomColor: accentColor + '44' }]}>
            <TouchableOpacity onPress={closeEmergencyMode} style={styles.exitBtn} activeOpacity={0.75}>
              <Text style={styles.exitBtnText}>✕ Exit</Text>
            </TouchableOpacity>
            <View style={[styles.modeBadge, { backgroundColor: accentColor + '20', borderColor: accentColor }]}>
              <View style={[styles.modeBadgeDot, { backgroundColor: accentColor }]} />
              <Text style={[styles.modeBadgeText, { color: accentColor }]}>{isBystander ? 'BYSTANDER MODE' : 'EMERGENCY MODE'}</Text>
            </View>
            <View style={{ width: 70 }} />
          </View>

          <View style={styles.tabRow}>
            {(['ALL', 'HOSPITAL', 'POLICE'] as const).map((tab) => {
              const tabIcons: Record<string, string> = { ALL: '🗺', HOSPITAL: '🏥', POLICE: '🚓' };
              const active = activeTab === tab;
              return (
                <TouchableOpacity key={tab} style={[styles.tabBtn, active && { backgroundColor: accentColor, ...SHADOW_DANGER }]} onPress={() => setActiveTab(tab)} activeOpacity={0.8}>
                  <Text style={styles.tabBtnIcon}>{tabIcons[tab]}</Text>
                  <Text style={[styles.tabBtnLabel, active && { color: COLORS.white }]}>{tab}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <FlatList
            data={filteredServices}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>📡</Text>
                <Text style={styles.emptyTitle}>No services found</Text>
                <Text style={styles.emptyBody}>No {activeTab} services detected nearby. Try broadening the filter.</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={[styles.serviceCard, { borderLeftColor: accentColor }]}>
                <Text style={styles.serviceIcon}>{getServiceIcon(item.type)}</Text>
                <View style={styles.serviceInfo}>
                  <Text style={styles.serviceName}>{item.name}</Text>
                  <Text style={[styles.serviceType, { color: accentColor }]}>{item.type.toUpperCase()}</Text>
                </View>
                <TouchableOpacity style={[styles.navBtn, { backgroundColor: accentColor }]} onPress={() => startNavigation(item.latitude || item.lat, item.longitude || item.lon)} activeOpacity={0.85}>
                  <Text style={styles.navBtnText}>GO  ›</Text>
                </TouchableOpacity>
              </View>
            )}
          />

          <View style={[styles.emergencyFooter, { backgroundColor: COLORS.surface }]}>
            {emergencyRole === 'USER' ? (
              <TouchableOpacity style={[styles.primaryActionBtn, { backgroundColor: COLORS.danger, ...SHADOW_DANGER }]} onPress={() => triggerSOS()} activeOpacity={0.88}>
                <Text style={styles.primaryActionIcon}>🚨</Text>
                <Text style={styles.primaryActionText}>DISPATCH SOS NOW</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[styles.primaryActionBtn, { backgroundColor: COLORS.amber, ...SHADOW_AMBER }]} onPress={() => Linking.openURL('tel:112')} activeOpacity={0.88}>
                <Text style={styles.primaryActionIcon}>📞</Text>
                <Text style={styles.primaryActionText}>DIAL 112 NOW</Text>
              </TouchableOpacity>
            )}
          </View>
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
              <Text style={styles.nearbyStripText}>📡  {nearbyServices.length} emergency service{nearbyServices.length > 1 ? 's' : ''} indexed nearby</Text>
            </View>
          )}

          <View style={styles.sliderWrapper}>
            <View style={styles.sliderTrack}>
              <Text style={styles.sliderHint} numberOfLines={1} adjustsFontSizeToFit>SWIPE TO ACTIVATE SOS  »</Text>
              <Animated.View {...panResponder.panHandlers} style={[styles.sliderKnob, { transform: [{ translateX: pan.x }] }]}>
                <Text style={styles.sliderKnobText}>»</Text>
              </Animated.View>
            </View>
            <Text style={styles.sliderCaption}>Slide right to open Emergency Mode</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const ui = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start', marginTop: 6 },
  badgeDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  badgeText: { fontSize: 10, fontWeight: FONT.bold, letterSpacing: 0.8 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  onboardingRoot: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 24, paddingTop: Platform.OS === 'ios' ? 70 : 50, paddingBottom: 40 },
  onboardingHeader: { marginBottom: 32 },
  onboardingBadge: { backgroundColor: COLORS.dangerMuted, borderRadius: RADIUS.pill, paddingHorizontal: 12, paddingVertical: 5, alignSelf: 'flex-start', marginBottom: 14 },
  onboardingBadgeText: { color: COLORS.danger, fontSize: 10, fontWeight: FONT.bold, letterSpacing: 2 },
  onboardingTitle: { fontSize: 40, fontWeight: FONT.black, color: COLORS.textPrimary, letterSpacing: -1 },
  onboardingSubtitle: { fontSize: 15, color: COLORS.textSecondary, marginTop: 8, lineHeight: 22 },
  onboardingForm: { flex: 1 },
  formGroupLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 10 },
  inputField: { backgroundColor: COLORS.surface, color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.surfaceBorder, borderRadius: RADIUS.md, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, marginBottom: 10 },
  inputRow: { flexDirection: 'row', gap: 10 },
  inputHalf: { flex: 1 },
  saveBtn: { backgroundColor: COLORS.danger, borderRadius: RADIUS.lg, paddingVertical: 18, alignItems: 'center', ...SHADOW_DANGER },
  saveBtnText: { color: COLORS.white, fontSize: 16, fontWeight: FONT.black, letterSpacing: 1.5 },
  roleOverlay: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'flex-end' },
  roleSheet: { backgroundColor: COLORS.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 44 },
  roleSheetEyebrow: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.danger, letterSpacing: 2, textAlign: 'center', marginBottom: 10 },
  roleSheetTitle: { fontSize: 26, fontWeight: FONT.black, color: COLORS.textPrimary, textAlign: 'center' },
  roleSheetSub: { fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  roleCardDanger: { backgroundColor: COLORS.dangerMuted, borderWidth: 1.5, borderColor: COLORS.danger, borderRadius: RADIUS.lg, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 14 },
  roleCardAmber: { backgroundColor: COLORS.amberMuted, borderWidth: 1.5, borderColor: COLORS.amber, borderRadius: RADIUS.lg, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  roleCardIcon: { fontSize: 28 },
  roleCardTitle: { fontSize: 17, fontWeight: FONT.bold, color: COLORS.textPrimary },
  roleCardSub: { fontSize: 12, color: COLORS.danger, marginTop: 3 },
  roleCardArrow: { fontSize: 26, color: COLORS.danger, fontWeight: FONT.bold },
  roleCancelBtn: { marginTop: 22, alignItems: 'center', padding: 10 },
  roleCancelText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: FONT.medium },
  crashScreen: { flex: 1, backgroundColor: '#1A0000', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
  crashPulseRing: { position: 'absolute', width: 320, height: 320, borderRadius: 160, borderWidth: 2, borderColor: COLORS.danger + '33' },
  crashEyebrow: { color: COLORS.danger, fontSize: 13, fontWeight: FONT.bold, letterSpacing: 2, marginBottom: 16 },
  crashTitle: { fontSize: 48, fontWeight: FONT.black, color: COLORS.textPrimary, textAlign: 'center', lineHeight: 50, letterSpacing: -2 },
  crashSub: { color: COLORS.textSecondary, fontSize: 16, marginTop: 24 },
  crashTimerBox: { alignItems: 'center', marginVertical: 12 },
  crashTimer: { fontSize: 120, fontWeight: FONT.black, color: COLORS.danger, lineHeight: 130, letterSpacing: -4 },
  crashTimerUnit: { fontSize: 14, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 4, marginTop: -10 },
  crashCancelBtn: { backgroundColor: COLORS.white, borderRadius: RADIUS.xl, paddingVertical: 20, paddingHorizontal: 40, marginTop: 28, alignSelf: 'stretch', alignItems: 'center' },
  crashCancelText: { color: COLORS.danger, fontSize: 18, fontWeight: FONT.black, letterSpacing: 1 },
  syncScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 40 },
  syncTitle: { fontSize: 22, fontWeight: FONT.black, color: COLORS.textPrimary, letterSpacing: 3, marginTop: 8 },
  syncSub: { fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 20 },
  emergencyRoot: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 40 },
  emergencyTopBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 16, borderBottomWidth: 1 },
  exitBtn: { backgroundColor: COLORS.surfaceRaised, borderRadius: RADIUS.pill, paddingHorizontal: 14, paddingVertical: 7 },
  exitBtnText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: FONT.semi },
  modeBadge: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 12, paddingVertical: 5 },
  modeBadgeDot: { width: 7, height: 7, borderRadius: 4, marginRight: 7 },
  modeBadgeText: { fontSize: 11, fontWeight: FONT.bold, letterSpacing: 1 },
  tabRow: { flexDirection: 'row', gap: 8, marginTop: 18, marginBottom: 16 },
  tabBtn: { flex: 1, backgroundColor: COLORS.surfaceRaised, borderRadius: RADIUS.md, paddingVertical: 10, alignItems: 'center' },
  tabBtnIcon: { fontSize: 16, marginBottom: 3 },
  tabBtnLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textSecondary, letterSpacing: 1 },
  listContent: { paddingBottom: 160 },
  serviceCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.md, borderLeftWidth: 3, padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12, ...SHADOW_SOFT },
  serviceIcon: { fontSize: 22 },
  serviceInfo: { flex: 1 },
  serviceName: { fontSize: 15, fontWeight: FONT.bold, color: COLORS.textPrimary },
  serviceType: { fontSize: 10, fontWeight: FONT.bold, letterSpacing: 1.2, marginTop: 3 },
  navBtn: { borderRadius: RADIUS.sm, paddingVertical: 10, paddingHorizontal: 16 },
  navBtnText: { color: COLORS.white, fontWeight: FONT.bold, fontSize: 13 },
  emptyState: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { fontSize: 18, fontWeight: FONT.bold, color: COLORS.textSecondary },
  emptyBody: { fontSize: 14, color: COLORS.textMuted, textAlign: 'center', lineHeight: 20 },
  emergencyFooter: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24 },
  primaryActionBtn: { borderRadius: RADIUS.xl, paddingVertical: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  primaryActionIcon: { fontSize: 22 },
  primaryActionText: { color: COLORS.white, fontSize: 18, fontWeight: FONT.black, letterSpacing: 1.5 },
  dashRoot: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 40 },
  dashHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  appName: { fontSize: 36, fontWeight: FONT.black, color: COLORS.textPrimary, letterSpacing: -1 },
  editProfileBtn: { backgroundColor: COLORS.surfaceRaised, borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4 },
  editProfileText: { color: COLORS.navBlue, fontSize: 14, fontWeight: FONT.semi },
  medCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.xl, padding: 20, marginBottom: 14, ...SHADOW_SOFT, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  medCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  medCardLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2 },
  bloodTypePill: { backgroundColor: COLORS.dangerMuted, borderWidth: 1, borderColor: COLORS.danger, borderRadius: RADIUS.pill, paddingHorizontal: 14, paddingVertical: 4 },
  bloodTypeText: { color: COLORS.danger, fontSize: 15, fontWeight: FONT.black },
  medRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  medField: { gap: 4 },
  medFieldLabel: { fontSize: 9, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2 },
  medFieldValue: { fontSize: 16, fontWeight: FONT.bold, color: COLORS.textPrimary },
  contactsCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.xl, padding: 20, marginBottom: 14, ...SHADOW_SOFT, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  contactsLabel: { fontSize: 10, fontWeight: FONT.bold, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 14 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  contactIndex: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  contactIndexText: { fontSize: 12, fontWeight: FONT.bold, color: COLORS.textSecondary },
  contactNum: { fontSize: 16, fontWeight: FONT.medium, color: COLORS.textPrimary },
  nearbyStrip: { backgroundColor: COLORS.surfaceRaised, borderRadius: RADIUS.md, paddingVertical: 10, paddingHorizontal: 16, marginBottom: 20, borderWidth: 1, borderColor: COLORS.surfaceBorder },
  nearbyStripText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: FONT.medium },
  sliderWrapper: { position: 'absolute', bottom: Platform.OS === 'ios' ? 50 : 36, left: 20, right: 20 },
  sliderTrack: { height: 68, backgroundColor: COLORS.dangerMuted, borderRadius: RADIUS.pill, justifyContent: 'center', borderWidth: 1.5, borderColor: COLORS.danger, overflow: 'hidden', ...SHADOW_DANGER },
  sliderHint: { position: 'absolute', width: '100%', textAlign: 'center', color: COLORS.danger, fontWeight: FONT.black, fontSize: 14, letterSpacing: 1.5 },
  sliderKnob: { position: 'absolute', left: 0, width: 68, height: 68, backgroundColor: COLORS.danger, borderRadius: RADIUS.pill, justifyContent: 'center', alignItems: 'center', ...SHADOW_DANGER },
  sliderKnobText: { color: COLORS.white, fontSize: 24, fontWeight: FONT.black },
  sliderCaption: { textAlign: 'center', color: COLORS.textMuted, fontSize: 11, marginTop: 8, letterSpacing: 0.5 },
});