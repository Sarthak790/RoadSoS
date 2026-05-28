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
    // These deep links tell the OS to immediately start turn-by-turn driving directions
    const iosUrl = `maps://?daddr=${lat},${lng}&dirflg=d`;
    const androidUrl = `google.navigation:q=${lat},${lng}`;
    
    const url = Platform.OS === 'ios' ? iosUrl : androidUrl;
  
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        // If the native Maps app is installed, fire it up directly!
        await Linking.openURL(url);
      } else {
        // THE FIX: Properly formatted Google Maps Directions API link
        const browserUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
        await Linking.openURL(browserUrl);
      }
    } catch (error) {
      Alert.alert("Error", "Could not open the navigation app.");
      console.error("Navigation Handoff Error:", error);
    }
};