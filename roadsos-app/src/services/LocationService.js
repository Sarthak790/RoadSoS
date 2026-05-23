import * as Location from 'expo-location';

export const getLiveLocation = async () => {
    try {
        // 1. Ask the user for emergency GPS access
        const { status } = await Location.requestForegroundPermissionsAsync();
        
        if (status !== 'granted') {
            throw new Error('Permission to access location was denied. RoadSOS requires GPS to function.');
        }

        // 2. Fetch the highest accuracy coordinates available
        // We use Accuracy.Highest because this is an emergency app where meters matter
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