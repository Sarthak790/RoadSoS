import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { Platform } from 'react-native';


// 1. The Offline Asset Bootstrapper
export const bootstrapOfflineDatabase = async () => {
    if (Platform.OS === 'web') {
        console.log("Web mode detected. Skipping native database boot.");
        return true; 
    }
    try {
        const dbName = 'roadsos_master.db';
        // Expo SQLite specifically looks for databases in this exact folder
        const dbDir = FileSystem.documentDirectory + 'SQLite/';
        const dbPath = dbDir + dbName;

        // 1. Ensure the SQLite directory actually exists on the phone
        const dirInfo = await FileSystem.getInfoAsync(dbDir);
        if (!dirInfo.exists) {
            console.log("Creating native SQLite directory...");
            await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });
        }

        // 2. Check if the database is already installed
        const dbInfo = await FileSystem.getInfoAsync(dbPath);
        if (!dbInfo.exists) {
            console.log("First launch detected! Unpacking bundled offline database...");
            
            // Grab the file from the local assets folder
            const dbAsset = require('../../assets/roadsos_master.db');
            const [{ localUri }] = await Asset.loadAsync(dbAsset);
            
            // Copy it deeply into the phone's storage
            await FileSystem.copyAsync({
                from: localUri,
                to: dbPath
            });
            
            console.log("Database unpacked successfully. Ready for immediate offline use.");
        } else {
            console.log("Offline database already exists. Bootstrapping skipped.");
        }
        
        return true;
    } catch (error) {
        console.error("Critical error unpacking database:", error);
        return false;
    }
};
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

const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
    const R = 6371; 
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
    return R * c; 
};

// 2. The Self-Healing Database Opener
export const openDatabase = async () => {
    const db = await SQLite.openDatabaseAsync('roadsos_master.db');
    
    // If the file is blank (like our placeholder), this builds the schema.
    // NOTICE: We are adding the 'sync_batch' integer for our Rolling Cache feature!
    await db.execAsync(`
        CREATE TABLE IF NOT EXISTS emergency_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_type TEXT,
            name TEXT,
            latitude REAL,
            longitude REAL,
            phone TEXT,
            sync_batch INTEGER DEFAULT 1
        );
    `);
    
    return db;
};

// 4. The Core Search Engine
export const getNearestServices = async (userLat, userLon, category) => {
    const db = await openDatabase();
    // Pull everything for this category
    const rows = await db.getAllAsync('SELECT * FROM emergency_services WHERE service_type = ?', [category]);

    const uniqueServices = new Map();

    for (const row of rows) {
        // Only process if we haven't seen this name yet
        if (!uniqueServices.has(row.name)) {
            
            // Fix the National Lifeline distance bug visually
            if (row.phone === '112' || row.phone === '108') {
                row.distance = 0; // Force it to the top
                row.isNational = true;
            } else {
                row.distance = getDistanceFromLatLonInKm(userLat, userLon, row.latitude, row.longitude);
                row.isNational = false;
            }
            
            uniqueServices.set(row.name, row);
        }
    }

    // Convert map to array, sort by distance, and return
    return Array.from(uniqueServices.values()).sort((a, b) => a.distance - b.distance);
};

// 1. Add this lock outside the function
let isSyncInProgress = false;
// 5. The Dynamic Network Sync Engine (With User-Agent Identity)
export const syncLiveArea = async (lat, lon) => {
    if (isSyncInProgress) {
        console.log("🚦 Sync already in progress. Ignoring duplicate GPS trigger.");
        return false;
    }
    
    isSyncInProgress = true; // Lock the door
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
        const query = `[out:json][timeout:15]t;(node["amenity"="hospital"](${south},${west},${north},${east});way["amenity"="hospital"](${south},${west},${north},${east});node["amenity"="clinic"](${south},${west},${north},${east});way["amenity"="clinic"](${south},${west},${north},${east});node["amenity"="police"](${south},${west},${north},${east});way["amenity"="police"](${south},${west},${north},${east});node["emergency"="ambulance_station"](${south},${west},${north},${east});way["emergency"="ambulance_station"](${south},${west},${north},${east});node["shop"="car_repair"](${south},${west},${north},${east});way["shop"="car_repair"](${south},${west},${north},${east});node["amenity"="fuel"](${south},${west},${north},${east});way["amenity"="fuel"](${south},${west},${north},${east}););out center tags;`;

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
            
            console.log("Executing Rolling Spatial Cache Update...");

            // 1. IMMORTALITY PROTOCOL: Protect National Lifelines by setting their batch to 0
            await db.execAsync("UPDATE emergency_services SET sync_batch = 0 WHERE phone IN ('112', '108')");

            // 2. AGE THE DATA: Push all existing local data back one generation in the queue
            // (We strictly ignore batch 0 so the lifelines never age)
            await db.execAsync("UPDATE emergency_services SET sync_batch = sync_batch + 1 WHERE sync_batch > 0");
            
            let insertedCount = 0;
            const insertQuery = await db.prepareAsync(
                'INSERT INTO emergency_services (service_type, name, latitude, longitude, phone, sync_batch) VALUES (?, ?, ?, ?, ?, ?)'
            );

            // THE FIX: Use a Map to filter duplicate building names from OpenStreetMap
            const uniqueServices = new Map();

            for (const element of validElements) {
                const tags = element.tags || {};
                const amenity = tags.amenity;
                const shop = tags.shop;
                const emergency = tags.emergency;
                
                let serviceType = 'unknown';
                if (amenity === 'hospital' || amenity === 'clinic') serviceType = 'hospital';
                else if (amenity === 'police') serviceType = 'police';
                else if (emergency === 'ambulance_station') serviceType = 'ambulance';
                else if (shop === 'car_repair') serviceType = 'mechanic';
                else if (amenity === 'fuel') serviceType = 'petrol_pump'; 

                const name = tags.name || `Unknown ${serviceType.toUpperCase()}`;
                const phone = tags.phone || tags['contact:phone'] || 'Not Available';
                const elementLat = element.lat || element.center?.lat;
                const elementLon = element.lon || element.center?.lon;

                if (elementLat && elementLon && serviceType !== 'unknown') {
                    // Create a unique key (e.g., "Arvind Medicare_hospital")
                    const uniqueKey = `${name}_${serviceType}`;
                    
                    // Only save it if we haven't seen this exact name yet
                    if (!uniqueServices.has(uniqueKey)) {
                        uniqueServices.set(uniqueKey, { serviceType, name, elementLat, elementLon, phone });
                    }
                }
            }

            // Now, insert only the unique filtered items into the database
            for (const service of uniqueServices.values()) {
                await insertQuery.executeAsync([
                    service.serviceType, 
                    service.name, 
                    service.elementLat, 
                    service.elementLon, 
                    service.phone, 
                    1
                ]);
                insertedCount++;
            }
            
            await insertQuery.finalizeAsync();

            // 4. THE PURGE: Delete anything older than 3 generations (ignoring immortal batch 0)
            const result = await db.runAsync("DELETE FROM emergency_services WHERE sync_batch > 3 AND sync_batch != 0");
            
            console.log(`✅ Rolling Cache Complete. Inserted ${insertedCount} new contacts. Purged ${result.changes} old contacts.`);
        } else {
             console.log("No new data found. Keeping the previous offline database cache.");
        }
        return true;

    } catch (error) {
        console.error("Critical Sync Failure:", error.message);
        return false; 
    }
};