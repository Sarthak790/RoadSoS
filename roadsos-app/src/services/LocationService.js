import * as Location from 'expo-location';

export const getLiveLocation = async () => {
    try {
        // 🚨 HACKATHON OVERRIDE: Force coordinates for testing 🚨
        // console.log("⚠️ MOCK GPS ACTIVE: Spoofing location to New Delhi ⚠️");
        
        // // Coordinates for Connaught Place, New Delhi
        // return {
        //     latitude: 28.6315,
        //     longitude: 77.2167
        // };

        
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
            throw new Error('Permission to access location was denied.');
        }
        const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Highest,
        });
        return {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
        };
        

    } catch (error) {
        console.error("GPS Error:", error);
        throw error;
    }
};