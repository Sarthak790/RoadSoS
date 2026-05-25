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
    const dbName = 'roadsos_patna_v2.db';
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

// 5. The Dynamic Network Sync Engine (With User-Agent Identity)
export const syncLiveArea = async (lat, lon) => {
    try {
        console.log(`Initiating Sync at GPS: Lat ${lat.toFixed(4)}, Lon ${lon.toFixed(4)}...`);
        
        const radiusKm = 5; 
        const deltaLat = radiusKm / 111.0; 
        const deltaLon = radiusKm / (111.0 * Math.cos(lat * (Math.PI / 180)));

        const south = lat - deltaLat;
        const north = lat + deltaLat;
        const west = lon - deltaLon;
        const east = lon + deltaLon;

        // THE FIX 1: A completely flattened query on a single line so URL encoding cannot break it.
        const query = `[out:json][timeout:15];(node["amenity"="hospital"](${south},${west},${north},${east});way["amenity"="hospital"](${south},${west},${north},${east});node["amenity"="clinic"](${south},${west},${north},${east});way["amenity"="clinic"](${south},${west},${north},${east});node["amenity"="police"](${south},${west},${north},${east});way["amenity"="police"](${south},${west},${north},${east});node["emergency"="ambulance_station"](${south},${west},${north},${east});way["emergency"="ambulance_station"](${south},${west},${north},${east});node["shop"="car_repair"](${south},${west},${north},${east});way["shop"="car_repair"](${south},${west},${north},${east});node["amenity"="fuel"](${south},${west},${north},${east});way["amenity"="fuel"](${south},${west},${north},${east}););out center tags;`;

        const ENDPOINTS = [
            'https://lz4.overpass-api.de/api/interpreter',
            'https://z.overpass-api.de/api/interpreter',
            'https://overpass-api.de/api/interpreter'
        ];

        let data = null;
        let success = false;

        for (let i = 0; i < ENDPOINTS.length; i++) {
            try {
                console.log(`Pinging Global Overpass Server ${i + 1}...`);
                
                // THE FIX 2: POST request with a custom User-Agent to bypass the bot filter
                const response = await fetch(ENDPOINTS[i], {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'RoadSOS-HackathonProject/1.0 (Student Emergency App)' // Let them know who we are!
                    },
                    body: `data=${encodeURIComponent(query)}`
                });
                
                if (response.ok) {
                    data = await response.json();
                    success = true;
                    console.log(`Server ${i + 1} accepted our identity and delivered the payload.`);
                    break; 
                } else {
                    console.log(`Server ${i + 1} rejected request. HTTP Status: ${response.status}`);
                }
            } catch (err) {
                console.log(`Server ${i + 1} failed network connection.`);
            }
        }

        if (!success || !data) {
            throw new Error("All global mirrors are currently unreachable.");
        }

        const validElements = data.elements || [];
        console.log(`Raw map buildings/nodes found by Overpass: ${validElements.length}`);
        
        if (validElements.length > 0) {
            const db = await openDatabase();
            await db.execAsync('DELETE FROM emergency_services');
            
            let insertedCount = 0;
            for (const element of validElements) {
                const tags = element.tags || {};
                const amenity = tags.amenity;
                const shop = tags.shop;
                const emergency = tags.emergency;
                
                let serviceType = 'unknown';
                
                // Categorize exactly to the hackathon brief
                if (amenity === 'hospital' || amenity === 'clinic') serviceType = 'hospital';
                else if (amenity === 'police') serviceType = 'police';
                else if (emergency === 'ambulance_station') serviceType = 'ambulance';
                else if (shop === 'car_repair') serviceType = 'mechanic';
                else if (amenity === 'fuel') serviceType = 'petrol_pump'; 

                const name = tags.name || `Unknown ${serviceType.toUpperCase()}`;
                
                // OpenStreetMap users store phone numbers in 3 different tags. We check all of them.
                const phone = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || 'Not Available';

                const elementLat = element.lat || element.center?.lat;
                const elementLon = element.lon || element.center?.lon;

                if (elementLat && elementLon && serviceType !== 'unknown') {
                    await db.runAsync(
                        'INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES (?, ?, ?, ?, ?)',
                        [serviceType, name, elementLat, elementLon, phone]
                    );
                    insertedCount++;
                }
            }
            // HACKATHON WINNING MOVE: Hardcode guaranteed national lifelines into the local offline cache
            await db.runAsync(
                'INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES (?, ?, ?, ?, ?)',
                ['police', 'National Emergency Response', lat, lon, '112'] // 112 is the universal emergency number in India
            );
            await db.runAsync(
                'INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES (?, ?, ?, ?, ?)',
                ['ambulance', 'National Ambulance Service', lat, lon, '108']
            );
            console.log(`SUCCESS: Cached ${insertedCount} fully compliant rescue contacts.`);
        } else {
             console.log("No new data found. Keeping the previous offline database cache.");
        }
        return true;

    } catch (error) {
        console.error("Critical Sync Failure:", error.message);
        return false; 
    }
};