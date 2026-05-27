import * as SMS from 'expo-sms';

export const sendEmergencySMS = async (liveCoords, services, profile, defaultNumbers = ['112']) => {
    try {
        // 1. Check if the device actually has a SIM card / SMS capabilities
        const isAvailable = await SMS.isAvailableAsync();
        if (!isAvailable) {
            console.error("CRITICAL: SMS is not available on this device/simulator.");
            return false;
        }

        // 2. Generate a clickable Google Maps fallback link
        const mapsLink = `https://maps.google.com/?q=${liveCoords.latitude},${liveCoords.longitude}`;

        // 3. Construct the Payload (Keep it dense to avoid SMS character splitting)
        let message = `🚨 EMERGENCY SOS 🚨\n`;
        message += `Name: ${profile.name || 'Unknown'}\n`;
        message += `Blood: ${profile.bloodType || 'Unknown'} | Veh: ${profile.vehicleId || 'Unknown'}\n`;
        message += `Loc: ${mapsLink}\n\n`;

        message += `NEARBY SAFE ZONES:\n`;
        services.forEach((service, index) => {
            const dist = service.distance < 1 ? `${(service.distance * 1000).toFixed(0)}m` : `${service.distance.toFixed(1)}km`;
            message += `${index + 1}. ${service.name} (${dist})\n`;
        });

        // 4. Inject the family emergency number into the recipient list!
        const recipients = [...defaultNumbers];
        if (profile.emergencyPhone) {
            recipients.push(profile.emergencyPhone);
        }

        console.log(`Sending Payload to: ${recipients.join(', ')}`);
        
        // 5. Fire the native SMS UI
        const { result } = await SMS.sendSMSAsync(recipients, message);
        
        console.log("SMS Dispatch Result:", result);
        return true;

    } catch (error) {
        console.error("SMS Engine Failure:", error);
        return false;
    }
};