import * as SMS from 'expo-sms';

export const sendEmergencySMS = async (liveCoords, nearestServices, emergencyContacts = ['112']) => {
    try {
        // 1. Check if the device is actually a phone with SMS capabilities
        const isAvailable = await SMS.isAvailableAsync();
        if (!isAvailable) {
            throw new Error("SMS is not available on this device (Emulator or Tablet without SIM).");
        }

        // 2. Format a clickable Google Maps link using their live GPS
        const mapsLink = `https://www.google.com/maps/search/?api=1&query=${liveCoords.latitude},${liveCoords.longitude}`;

        // 3. Compress the offline database results into a tight text string
        let servicesText = "\n\nNearest Offline Facilities Found:\n";
        
        // Take the top 3 results and format them
        nearestServices.slice(0, 3).forEach((service, index) => {
            servicesText += `${index + 1}. ${service.name} (${service.distance.toFixed(1)}km away)\nPh: ${service.phone}\n`;
        });

        // 4. Construct the final SOS message payload
        const messagePayload = `🚨 RoadSOS EMERGENCY 🚨\nI need immediate assistance. My exact GPS location is:\n${mapsLink}${servicesText}`;

        // 5. Open the native SMS app with the payload pre-filled
        const { result } = await SMS.sendSMSAsync(
            emergencyContacts, // You can replace '112' with a family member's number for testing
            messagePayload
        );

        return result;

    } catch (error) {
        console.error("SMS Dispatch Failed:", error);
        throw error;
    }
};