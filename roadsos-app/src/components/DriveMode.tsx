import * as Brightness from 'expo-brightness';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Accelerometer } from 'expo-sensors';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    Vibration,
    View,
} from 'react-native';

// ─── Service Imports ──────────────────────────────────────────────────────────
import { getLocalEmergencyServices } from '../services/DatabaseService';
import { getLiveLocation } from '../services/LocationService';
import { sendEmergencySMS } from '../services/SmsService';

// ─── Types ────────────────────────────────────────────────────────────────────
type AlertLevel = 'none' | 'pothole' | 'crash';
type EventType = 'pothole' | 'crash';

interface EventLogItem {
  id: number;
  type: EventType;
  g: string;
  time: string;
}

interface SensorData {
  x: number;
  y: number;
  z: number;
}

// ─── Tunable thresholds ───────────────────────────────────────────────────────
const POTHOLE_THRESHOLD = 2.5; // resultant g-force
const CRASH_THRESHOLD   = 4.0;
const UPDATE_INTERVAL   = 200; // ms → 5 Hz
const ALERT_RESET_MS    = { pothole: 1500, crash: 3000 };

// ─── Component ────────────────────────────────────────────────────────────────
export default function DriveMode() {
  const [isDriving, setIsDriving]   = useState<boolean>(false);
  const [isLoading, setIsLoading]   = useState<boolean>(false);
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('none');
  const [gForce, setGForce]         = useState<number>(0);
  const [eventLog, setEventLog]     = useState<EventLogItem[]>([]);

  // Refs with proper TypeScript definitions
  const originalBrightnessRef  = useRef<number | null>(null);
  const subscriptionRef = useRef<{ remove: () => void } | null>(null);
  const alertTimerRef = useRef<NodeJS.Timeout | number | null>(null);
  const isDrivingRef           = useRef<boolean>(false); 
  const isHandlingEmergencyRef = useRef<boolean>(false); // 🚨 The SOS Lock

  useEffect(() => { isDrivingRef.current = isDriving; }, [isDriving]);

  // ── Append to the on-screen event log ───────────────────────────────────────
  const logEvent = useCallback((type: EventType, magnitude: number) => {
    const time = new Date().toLocaleTimeString();
    setEventLog(prev => [
      { id: Date.now(), type, g: magnitude.toFixed(2), time },
      ...prev.slice(0, 9),
    ]);
  }, []);

  // ── Core detection logic ────────────────────────────────────────────────────
  const handleSensorData = useCallback(({ x, y, z }: SensorData) => {
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    setGForce(magnitude);

    let detected: EventType | null = null;
    if (magnitude > CRASH_THRESHOLD)  detected = 'crash';
    else if (magnitude > POTHOLE_THRESHOLD) detected = 'pothole';

    if (detected) {
      setAlertLevel(detected);
      Vibration.vibrate(detected === 'crash' ? [0, 500, 200, 500] : 200);
      logEvent(detected, magnitude);

      // 🚨 CRASH SOS TRIGGER LOGIC 🚨
      if (detected === 'crash' && !isHandlingEmergencyRef.current) {
        isHandlingEmergencyRef.current = true; // Lock the system to prevent duplicate texts

        // Run the heavy location and SMS tasks in the background
        (async () => {
          try {
            console.log("🚨 CRASH DETECTED: Fetching GPS and Vault Data...");
            
            // 1. Get exact GPS coordinates
            const coords = await getLiveLocation();
            
            // 2. Query SQLite for the nearest hospitals/police
            const nearestServices = await getLocalEmergencyServices(coords.latitude, coords.longitude);
            
            // 3. Dispatch the formatted SMS 
            // (Leaving profile null for now, using default contacts in the service)
            const smsSent = await sendEmergencySMS(coords, nearestServices, null);
            
            if (smsSent) {
               console.log("✅ Emergency SOS Dispatched Successfully.");
            }
          } catch (error) {
            console.error("❌ Failed to dispatch SOS:", error);
          } finally {
            // Keep the lock active for 60 seconds to prevent spam
            setTimeout(() => {
              isHandlingEmergencyRef.current = false;
            }, 60000); 
          }
        })();
      }

      // Reset the on-screen UI alert after the specified time
      if (alertTimerRef.current) {
        clearTimeout(alertTimerRef.current);
      }
      
      alertTimerRef.current = setTimeout(
        () => setAlertLevel('none'),
        ALERT_RESET_MS[detected]
      );
    }
  }, [logEvent]);

  // ── Start ───────────────────────────────────────────────────────────────────
  const startDriveMode = async () => {
    setIsLoading(true);
    try {
      const { status } = await Brightness.requestPermissionsAsync();
      if (status === 'granted') {
        originalBrightnessRef.current = await Brightness.getBrightnessAsync();
        await Brightness.setSystemBrightnessAsync(0.05);
      } else {
        Alert.alert(
          'Permission Denied',
          'Brightness control is unavailable. The screen may stay bright.'
        );
      }

      await activateKeepAwakeAsync('drive-mode-lock');

      Accelerometer.setUpdateInterval(UPDATE_INTERVAL);
      subscriptionRef.current = Accelerometer.addListener(handleSensorData);

      setIsDriving(true);
    } catch (err) {
      console.error('startDriveMode error:', err);
      Alert.alert('Error', 'Could not start Drive Mode. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // ── Stop ────────────────────────────────────────────────────────────────────
  const stopDriveMode = useCallback(async () => {
    try {
      if (originalBrightnessRef.current !== null) {
        await Brightness.setSystemBrightnessAsync(originalBrightnessRef.current);
        originalBrightnessRef.current = null;
      }

      deactivateKeepAwake('drive-mode-lock');

      subscriptionRef.current?.remove();
      subscriptionRef.current = null;

      if (alertTimerRef.current) {
        clearTimeout(alertTimerRef.current);
        alertTimerRef.current = null;
      }

      setAlertLevel('none');
      setGForce(0);
      setIsDriving(false);
      // Reset the emergency lock when manual stop is pressed
      isHandlingEmergencyRef.current = false; 
    } catch (err) {
      console.error('stopDriveMode error:', err);
    }
  }, []);

  // ── Unmount cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    return () => { if (isDrivingRef.current) stopDriveMode(); };
  }, [stopDriveMode]);

  // ── Derived UI values ───────────────────────────────────────────────────────
  const containerStyle = [
    styles.container,
    alertLevel === 'crash'   ? styles.bgCrash   :
    alertLevel === 'pothole' ? styles.bgPothole :
    isDriving                ? styles.bgDark    : styles.bgLight,
  ];

  const alertEmoji = alertLevel === 'crash' ? '🚨' : alertLevel === 'pothole' ? '⚠️' : null;
  const alertText  = alertLevel === 'crash' ? 'CRASH DETECTED' : alertLevel === 'pothole' ? 'Pothole Detected' : null;

  const crashes  = eventLog.filter(e => e.type === 'crash').length;
  const potholes = eventLog.filter(e => e.type === 'pothole').length;

  return (
    <View style={containerStyle}>
      {alertLevel !== 'none' && (
        <View style={styles.alertBanner}>
          <Text style={styles.alertEmoji}>{alertEmoji}</Text>
          <Text style={styles.alertText}>{alertText}</Text>
        </View>
      )}

      {isDriving && (
        <View style={styles.statsRow}>
          <StatPill label="G-Force" value={`${gForce.toFixed(2)}g`} />
          <StatPill label="Potholes" value={potholes} />
          <StatPill label="Crashes"  value={crashes}  />
        </View>
      )}

      {!isDriving ? (
        <TouchableOpacity
          style={[styles.btnStart, isLoading && styles.btnDisabled]}
          onPress={startDriveMode}
          disabled={isLoading}
          activeOpacity={0.85}
        >
          <Text style={styles.btnText}>
            {isLoading ? 'Activating…' : '🚗  Start Drive Mode'}
          </Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.btnStop} onPress={stopDriveMode} activeOpacity={0.85}>
          <Text style={styles.btnText}>■  Stop Drive Mode</Text>
          <Text style={styles.btnSub}>Sensors active ●</Text>
        </TouchableOpacity>
      )}

      {isDriving && eventLog.length > 0 && (
        <View style={styles.logWrap}>
          <Text style={styles.logHeader}>Recent events</Text>
          <ScrollView>
            {eventLog.map(ev => (
              <Text key={ev.id} style={styles.logRow}>
                {ev.time}  {ev.type === 'crash' ? '🚨' : '⚠️'}  {ev.type}  ({ev.g}g)
              </Text>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ─── Stat Pill Component ──────────────────────────────────────────────────────
interface StatPillProps {
  label: string;
  value: string | number;
}

function StatPill({ label, value }: StatPillProps) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillValue}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  bgLight:   { backgroundColor: '#F5F5F5' },
  bgDark:    { backgroundColor: '#0A0A0A' },
  bgCrash:   { backgroundColor: '#CC0000' },
  bgPothole: { backgroundColor: '#CC6600' },

  alertBanner: { alignItems: 'center', marginBottom: 28 },
  alertEmoji:  { fontSize: 52 },
  alertText:   { color: '#FFFFFF', fontSize: 26, fontWeight: '900', marginTop: 6, letterSpacing: 1 },

  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 36 },
  pill:      { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  pillValue: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  pillLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 },

  btnStart:    { paddingVertical: 20, paddingHorizontal: 40, backgroundColor: '#007BFF', borderRadius: 14, alignItems: 'center', elevation: 4 },
  btnStop:     { width: 200, height: 200, borderRadius: 100, backgroundColor: '#FF3B30', justifyContent: 'center', alignItems: 'center', elevation: 4 },
  btnDisabled: { backgroundColor: '#888' },
  btnText:     { color: '#FFFFFF', fontWeight: '800', fontSize: 17 },
  btnSub:      { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 6 },

  logWrap:   { position: 'absolute', bottom: 36, left: 20, right: 20, maxHeight: 130 },
  logHeader: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 4, textTransform: 'uppercase' },
  logRow:    { color: 'rgba(255,255,255,0.65)', fontSize: 12, paddingVertical: 2 },
});