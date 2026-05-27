import AsyncStorage from '@react-native-async-storage/async-storage';

const PROFILE_KEY = '@roadsos_user_profile';

export const saveUserProfile = async (profileData) => {
    try {
        const jsonValue = JSON.stringify(profileData);
        await AsyncStorage.setItem(PROFILE_KEY, jsonValue);
        return true;
    } catch (e) {
        console.error("Failed to save profile:", e);
        return false;
    }
};

export const getUserProfile = async () => {
    try {
        const jsonValue = await AsyncStorage.getItem(PROFILE_KEY);
        return jsonValue != null ? JSON.parse(jsonValue) : null;
    } catch (e) {
        console.error("Failed to fetch profile:", e);
        return null;
    }
};