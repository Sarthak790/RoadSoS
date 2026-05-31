import * as Location from 'expo-location';
import { Linking, Platform, Alert } from 'react-native';

export const getLiveLocation = async () => {
    try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        
        if (status !== 'granted') {
            throw new Error('Permission to access location was denied. RoadSOS requires GPS to function.');
        }

        const locationPromise = Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Highest,
        });

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('GPS_TIMEOUT')), 6000)
        );

        let location;
        try {
            location = await Promise.race([locationPromise, timeoutPromise]);
        } catch (error) {
            if (error.message === 'GPS_TIMEOUT') {
                console.log("⚠️ Perfect GPS took too long. Falling back to Last Known Location.");
                location = await Location.getLastKnownPositionAsync({});
                if (!location) throw new Error("Could not determine location even with fallback.");
            } else {
                throw error;
            }
        }

        return {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy 
        };

    } catch (error) {
        console.error("GPS Error:", error);
        throw error;
    }
};

// ==========================================
// OS-LEVEL NAVIGATION HANDOFF
// ==========================================
export const startNavigation = async (lat, lng) => {
    // 1. Safety check to ensure we don't pass undefined coordinates to the OS
    if (!lat || !lng) {
        Alert.alert("Location Error", "Exact GPS coordinates are missing for this location.");
        return;
    }

    // 2. Android: Force Google Maps immediately into Turn-by-Turn driving mode
    const androidUrl = `google.navigation:q=${lat},${lng}`;
    
    // 3. iOS: Force Apple Maps routing
    const iosUrl = `maps://?daddr=${lat},${lng}&dirflg=d`;
    
    // THE FIX: Official Google Maps Universal URL (Browser Fallback)
    // This strictly routes to coordinates and ignores fuzzy name matching
    const universalUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

    const targetUrl = Platform.OS === 'android' ? androidUrl : iosUrl;
  
    try {
      const supported = await Linking.canOpenURL(targetUrl);
      if (supported) {
        // If the native OS Maps app is ready, fire it up directly!
        await Linking.openURL(targetUrl);
      } else {
        // Fallback to the strict Google Maps browser link
        await Linking.openURL(universalUrl);
      }
    } catch (error) {
      // Ultimate fallback if the native Linking API crashes completely
      console.error("Navigation Handoff Error, attempting browser fallback:", error);
      Linking.openURL(universalUrl).catch(() => {
        Alert.alert("Error", "Could not open any navigation app or browser.");
      });
    }
};