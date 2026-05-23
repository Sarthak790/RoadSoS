// 1. We use the modern SQLite, but keep the legacy FileSystem to avoid crashes
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';

// 2. The Haversine Formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
    return R * c; 
}

// 3. Initialize and Open the Database
async function openDatabase() {
    const dbName = 'roadsos_patna.db';
    const dbAsset = require('../../assets/roadsos_patna.db');
    const dbUri = Asset.fromModule(dbAsset).uri;
    const dbFilePath = `${FileSystem.documentDirectory}SQLite/${dbName}`;

    // Copy the database from assets to active memory if it isn't there yet
    const fileInfo = await FileSystem.getInfoAsync(dbFilePath);
    if (!fileInfo.exists) {
        await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}SQLite`, { intermediates: true });
        await FileSystem.downloadAsync(dbUri, dbFilePath);
    }
    
    // THE MODERN WAY: Simple async open
    return await SQLite.openDatabaseAsync(dbName);
}

// 4. The Core Search Engine
export const getNearestServices = async (userLat, userLon, serviceType = null) => {
    try {
        const db = await openDatabase();
        
        let query = 'SELECT * FROM emergency_services';
        let params = [];

        if (serviceType) {
            query += ' WHERE service_type = ?';
            params.push(serviceType);
        }

        // THE MODERN WAY: getAllAsync replaces the transaction callbacks
        const _array = await db.getAllAsync(query, params);
            
        const servicesWithDistance = _array.map(service => {
            const distance = calculateDistance(userLat, userLon, service.latitude, service.longitude);
            return { ...service, distance };
        });

        const sortedServices = servicesWithDistance.sort((a, b) => a.distance - b.distance);
        return sortedServices.slice(0, 10);
        
    } catch (error) {
        console.error("Database Query Failed:", error);
        throw error;
    }
};

// 5. The Dynamic Network Sync Engine
// 5. The Dynamic Network Sync Engine (Upgraded for Vehicle Rescue)
export const syncLiveArea = async (lat, lon) => {
    try {
        console.log("Initiating Expanded Overpass API Sync...");
        
        const radiusKm = 15;
        const deltaLat = radiusKm / 111.0; 
        const deltaLon = radiusKm / (111.0 * Math.cos(lat * (Math.PI / 180)));

        const south = lat - deltaLat;
        const north = lat + deltaLat;
        const west = lon - deltaLon;
        const east = lon + deltaLon;

        // UPDATED: Added car repair, motorcycle repair, tyre shops, and towing
        const query = `
            [out:json][timeout:15];
            (
              node["amenity"="hospital"](${south},${west},${north},${east});
              node["amenity"="clinic"](${south},${west},${north},${east});
              node["amenity"="police"](${south},${west},${north},${east});
              node["shop"="car_repair"](${south},${west},${north},${east});
              node["shop"="motorcycle_repair"](${south},${west},${north},${east});
              node["shop"="tyres"](${south},${west},${north},${east});
              node["amenity"="vehicle_towing"](${south},${west},${north},${east});
            );
            out body;
        `;

        const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error("Overpass server rejected the request. It might be busy.");
        }
        
        const data = await response.json();
        const db = await openDatabase();
        
        await db.execAsync('DELETE FROM emergency_services');

        let insertedCount = 0;
        for (const element of data.elements) {
            if (element.type === 'node') {
                const amenity = element.tags?.amenity;
                const shop = element.tags?.shop; // We need to check 'shop' tags now too
                
                let serviceType = 'unknown';
                
                // Categorize the new tags
                if (amenity === 'hospital' || amenity === 'clinic') serviceType = 'hospital';
                else if (amenity === 'police') serviceType = 'police';
                else if (shop === 'car_repair' || shop === 'motorcycle_repair') serviceType = 'mechanic';
                else if (shop === 'tyres') serviceType = 'puncture';
                else if (amenity === 'vehicle_towing') serviceType = 'towing';

                const name = element.tags?.name || `Unknown ${serviceType.toUpperCase()}`;
                const phone = element.tags?.phone || 'Not Available';

                await db.runAsync(
                    'INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES (?, ?, ?, ?, ?)',
                    [serviceType, name, element.lat, element.lon, phone]
                );
                insertedCount++;
            }
        }

        console.log(`Sync Complete: Cached ${insertedCount} comprehensive rescue contacts offline.`);
        return true;

    } catch (error) {
        console.error("Sync Failed (Will rely on existing offline data):", error.message);
        return false; 
    }
};