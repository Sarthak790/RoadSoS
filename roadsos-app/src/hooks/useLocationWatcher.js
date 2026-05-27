import { useEffect, useState, useRef } from 'react';
import * as Location from 'expo-location';
import { syncAreaIfNeeded, getTileId } from '../services/DatabaseService'; 

// 🚨 Added isVaultReady parameter to prevent the SQLite race condition
export const useLocationWatcher = (isVaultReady) => {
  const [status, setStatus] = useState('Initializing...');
  
  // THE MEMORY TRACKER: Remembers what 10km grid we are currently inside
  const lastTileIdRef = useRef(null); 
  
  // PREVENTS MEMORY LEAKS: Tracks if the component is still alive
  const isMounted = useRef(true);

  useEffect(() => {
    // 🚨 THE GREEN LIGHT: If the vault isn't ready yet, pause and wait.
    if (!isVaultReady) {
      if (isMounted.current) setStatus('Waiting for Vault to initialize...');
      return; 
    }

    let locationSubscription = null;
    isMounted.current = true; // Component just mounted

    const startTracking = async () => {
      try {
        if (isMounted.current) setStatus('Requesting GPS Access...');
        const { status: currentStatus } = await Location.requestForegroundPermissionsAsync();
        
        if (currentStatus !== 'granted') {
          if (isMounted.current) setStatus('GPS Access Denied. Safety Net offline.');
          return;
        }

        if (isMounted.current) setStatus('GPS Locked. Silent Co-Pilot Active.');

        // ==========================================
        // 1. IMMEDIATE INITIALIZATION & EMULATOR FIX
        // ==========================================
        let initialLocation;
        try {
          // Get the very first location pulse
          initialLocation = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        } catch (bootError) {
          // If the emulator fails, intercept it here!
          console.log("⚠️ GPS fetch failed. Using Fallback Coordinates to initialize Vault.");
          
          const fallbackLat = 40.785091; // Central Park, NY
          const fallbackLon = -73.968285;
          
          lastTileIdRef.current = getTileId(fallbackLat, fallbackLon);
          if (isMounted.current) setStatus('Emulator Bypass Active. Vault synced to NY.');
          
          await syncAreaIfNeeded(fallbackLat, fallbackLon);
          return; // Stop here. Watcher will crash the emulator anyway.
        }

        // If we succeeded (Real phone), sync the immediate area right now!
        if (initialLocation) {
          const { latitude, longitude } = initialLocation.coords;
          lastTileIdRef.current = getTileId(latitude, longitude);
          
          console.log(`[Watcher] Initial boot. Securing current tile: ${lastTileIdRef.current}`);
          await syncAreaIfNeeded(latitude, longitude);
        }

        // ==========================================
        // 2. THE BACKGROUND WATCHER (Fires every 1km)
        // ==========================================
        locationSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            distanceInterval: 1000, 
          },
          (location) => {
            const { latitude, longitude } = location.coords;
            const currentTileId = getTileId(latitude, longitude);

            // The Border Check: Did we cross into a new grid?
            if (currentTileId !== lastTileIdRef.current) {
              console.log(`[Watcher] Crossed border into new tile: ${currentTileId}. Waking up engine...`);
              
              lastTileIdRef.current = currentTileId; 
              syncAreaIfNeeded(latitude, longitude);
            } else {
              console.log(`[Watcher] Moved 1km, but still inside ${currentTileId}. System resting.`);
            }
          }
        );
      } catch (error) {
        console.error("Location Watcher Error:", error);
        if (isMounted.current) setStatus('Tracking Error.');
      }
    };

    startTracking();

    // CLEANUP FUNCTION: Runs when the component unmounts
    return () => {
      isMounted.current = false;
      if (locationSubscription) {
        locationSubscription.remove();
      }
    };
  }, [isVaultReady]); // 🚨 Re-run this effect when isVaultReady flips to true

  return status;
};