// build_master_db.js (RUN THIS ON YOUR LAPTOP, NOT ON THE PHONE)
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const fs = require('fs');

const DB_PATH = './assets/roadsos_master.db';

// 1. Delete the blank dummy file if it exists
if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
}

// 2. Initialize the real database
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    // Create the exact schema the app expects
    db.run(`
        CREATE TABLE IF NOT EXISTS emergency_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_type TEXT,
            name TEXT,
            latitude REAL,
            longitude REAL,
            phone TEXT,
            sync_batch INTEGER DEFAULT 1
        )
    `);
});

// The 10 Strategic Corridors (Including your primary transit routes!)
const CITIES = [
    { name: "Patna", lat: 25.5941, lon: 85.1376 },
    { name: "Gaya", lat: 24.7914, lon: 85.0002 },
    { name: "Kolkata", lat: 22.5726, lon: 88.3639 },
    { name: "Kharagpur", lat: 22.3302, lon: 87.3237 },
    { name: "New Delhi", lat: 28.6139, lon: 77.2090 },
    { name: "Mumbai", lat: 19.0760, lon: 72.8777 },
    { name: "Bangalore", lat: 12.9716, lon: 77.5946 },
    { name: "Chennai", lat: 13.0827, lon: 80.2707 },
    { name: "Hyderabad", lat: 17.3850, lon: 78.4867 },
    { name: "Pune", lat: 18.5204, lon: 73.8567 }
];

const scrapeCity = async (city) => {
    console.log(`\n📡 Scraping Overpass for ${city.name}...`);
    
    const radiusKm = 10; // Larger radius for the master DB
    const deltaLat = radiusKm / 111.0;
    const deltaLon = radiusKm / (111.0 * Math.cos(city.lat * (Math.PI / 180)));

    const south = city.lat - deltaLat;
    const north = city.lat + deltaLat;
    const west = city.lon - deltaLon;
    const east = city.lon + deltaLon;

    const query = `[out:json][timeout:25];(node["amenity"="hospital"](${south},${west},${north},${east});way["amenity"="hospital"](${south},${west},${north},${east});node["amenity"="police"](${south},${west},${north},${east});way["amenity"="police"](${south},${west},${north},${east});node["shop"="car_repair"](${south},${west},${north},${east});way["shop"="car_repair"](${south},${west},${north},${east}););out center tags;`;

    try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RoadSOS-MasterBuilder/1.0' },
            body: `data=${encodeURIComponent(query)}`
        });

        const data = await response.json();
        const elements = data.elements || [];
        
        let count = 0;
        const stmt = db.prepare('INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES (?, ?, ?, ?, ?)');
        
        for (const el of elements) {
            const tags = el.tags || {};
            let type = 'unknown';
            if (tags.amenity === 'hospital') type = 'hospital';
            else if (tags.amenity === 'police') type = 'police';
            else if (tags.shop === 'car_repair') type = 'mechanic';

            const lat = el.lat || el.center?.lat;
            const lon = el.lon || el.center?.lon;
            const phone = tags.phone || 'Not Available';
            const name = tags.name || `Unknown ${type.toUpperCase()}`;

            if (lat && lon && type !== 'unknown') {
                stmt.run(type, name, lat, lon, phone);
                count++;
            }
        }
        stmt.finalize();
        console.log(`✅ Cached ${count} contacts for ${city.name}`);
        
    } catch (err) {
        console.error(`❌ Failed to scrape ${city.name}:`, err.message);
    }
};

const buildMasterDatabase = async () => {
    for (const city of CITIES) {
        await scrapeCity(city);
        // Sleep for 3 seconds between cities so Overpass doesn't ban our IP
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Inject National Lifelines as a fallback for dead zones
    db.run(`INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES ('police', 'National Emergency Response', 0, 0, '112')`);
    db.run(`INSERT INTO emergency_services (service_type, name, latitude, longitude, phone) VALUES ('ambulance', 'National Ambulance Service', 0, 0, '108')`);
    
    db.close();
    console.log(`\n🎉 MASTER DATABASE COMPILED SUCCESSFULLY!`);
    console.log(`The file is ready at: ${DB_PATH}`);
};

buildMasterDatabase();