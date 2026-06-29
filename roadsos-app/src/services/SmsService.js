import * as SMS from 'expo-sms';

export const sendEmergencySMS = async (liveCoords, nearestServices, profile = null, defaultContacts = ['9876543210']) => {
    try {
        const isAvailable = await SMS.isAvailableAsync();
        if (!isAvailable) {
            console.error("SMS is not available on this device.");
            return false;
        }

        // THE MAPS FIX: Perfectly formatted string literal!
        const mapsLink = `https://maps.google.com/?q=${liveCoords.latitude},${liveCoords.longitude}`;

        // THE SMART VARIETY FIX
        let servicesText = "\n\nNearest Offline Facilities:\n";
        
        if (nearestServices && nearestServices.length > 0) {
            // Find the closest of each distinct category
            const med = nearestServices.find(s => ['hospital', 'pharmacy'].includes(s.type));
            const pol = nearestServices.find(s => ['police', 'fire_station'].includes(s.type));
            const mech = nearestServices.find(s => ['car_repair', 'motorcycle_repair', 'fuel'].includes(s.type));

            // Combine them, filter out any missing ones, and ensure we always have 3 items
            let bestThree = [med, pol, mech].filter(Boolean);
            if (bestThree.length < 3) {
                const extras = nearestServices.filter(s => !bestThree.includes(s));
                bestThree = [...bestThree, ...extras].slice(0, 3);
            }

            bestThree.forEach((service, index) => {
                const distStr = service.distance !== undefined ? ` (${service.distance.toFixed(1)}km)` : '';
                const phoneStr = service.phone ? ` - Ph: ${service.phone}` : '';
                
                // Add tiny emoji tags so the text message is readable
                const tag = service.type === 'fuel' ? '⛽' : service.type.includes('repair') ? '🔧' : service.type === 'police' ? '🚓' : '🏥';
                
                servicesText += `${index + 1}. [${tag}] ${service.name}${distStr}${phoneStr}\n`;
            });
        } else {
            servicesText += "None found in immediate offline radius.\n";
        }

        let messagePayload = `🚨 RoadSOS EMERGENCY 🚨\n`;
        if (profile) {
            messagePayload += `Driver: ${profile.name || 'Unknown'}\n`;
            messagePayload += `Vitals: Blood ${profile.bloodType || 'N/A'} | Veh: ${profile.vehicleId || 'N/A'}\n`;
        }
        messagePayload += `Loc: ${mapsLink}${servicesText}`;

        const recipients = [...defaultContacts];
        if (profile?.emergencyPhone) {
            recipients.push(profile.emergencyPhone);
        }

        console.log("Dispatching Payload:\n", messagePayload);

        const { result } = await SMS.sendSMSAsync(recipients, messagePayload);
        return result === 'sent' || result === 'unknown';

    } catch (error) {
        console.error("SMS Dispatch Failed:", error);
        return false;
    }
};