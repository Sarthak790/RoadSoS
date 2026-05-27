import * as SMS from 'expo-sms';

export const sendEmergencySMS = async (liveCoords, nearestServices, profile = null, defaultContacts = ['112']) => {
    try {
        // 1. Hardware Check: Prevents silent crashes on Emulators/Web
        const isAvailable = await SMS.isAvailableAsync();
        if (!isAvailable) {
            console.error("SMS is not available on this device (Emulator or Web).");
            return false;
        }

        // 2. Format a clickable Google Maps link
        const mapsLink = `https://maps.google.com/?q=${liveCoords.latitude},${liveCoords.longitude}`;

        // 3. Compress the offline database results (Top 3)
        let servicesText = "\n\nNearest Offline Facilities:\n";
        if (nearestServices && nearestServices.length > 0) {
            nearestServices.slice(0, 3).forEach((service, index) => {
                const distStr = service.distance ? ` (${service.distance.toFixed(1)}km)` : '';
                const phoneStr = service.phone ? ` - Ph: ${service.phone}` : '';
                servicesText += `${index + 1}. ${service.name}${distStr}${phoneStr}\n`;
            });
        } else {
            servicesText += "None found in immediate offline radius.\n";
        }

        // 4. Construct the Payload
        let messagePayload = `🚨 RoadSOS EMERGENCY 🚨\n`;
        if (profile) {
            messagePayload += `Driver: ${profile.name || 'Unknown'}\n`;
            messagePayload += `Vitals: Blood ${profile.bloodType || 'N/A'} | Veh: ${profile.vehicleId || 'N/A'}\n`;
        }
        messagePayload += `Loc: ${mapsLink}${servicesText}`;

        // 5. Gather recipients
        const recipients = [...defaultContacts];
        if (profile?.emergencyPhone) {
            recipients.push(profile.emergencyPhone);
        }

        console.log("Dispatching Payload:\n", messagePayload);

        // 6. Fire the native SMS UI
        const { result } = await SMS.sendSMSAsync(recipients, messagePayload);

        return result === 'sent' || result === 'unknown';

    } catch (error) {
        console.error("SMS Dispatch Failed:", error);
        return false;
    }
};