import * as Location from 'expo-location';

export const getLiveLocation = async () => {
    try {
        // 1. Ask the user for emergency GPS access
        const { status } = await Location.requestForegroundPermissionsAsync();
        
        if (status !== 'granted') {
            throw new Error('Permission to access location was denied. RoadSOS requires GPS to function.');
        }

        // 2. The Emergency Timeout Race
        // We try to get the HIGHEST accuracy, but if it takes longer than 6 seconds, we abort and use the fallback.
        const locationPromise = Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Highest,
        });

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('GPS_TIMEOUT')), 6000)
        );

        let location;
        try {
            // Race the GPS fetch against the 6-second timer
            location = await Promise.race([locationPromise, timeoutPromise]);
        } catch (error) {
            if (error.message === 'GPS_TIMEOUT') {
                console.log("⚠️ Perfect GPS took too long. Falling back to Last Known Location.");
                // Fallback: Instantly grabs the last ping the phone recorded (usually accurate enough)
                location = await Location.getLastKnownPositionAsync({});
                
                if (!location) {
                    throw new Error("Could not determine location even with fallback.");
                }
            } else {
                throw error;
            }
        }

        return {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            // Returning accuracy is helpful so your UI can say "Accurate to 5 meters" vs "Accurate to 100 meters"
            accuracy: location.coords.accuracy 
        };

    } catch (error) {
        console.error("GPS Error:", error);
        throw error;
    }
};