import * as SQLite from 'expo-sqlite';

// Open or create the local vault
const db = SQLite.openDatabaseSync('roadsos_global_vault.db');

export const initializeSmartVault = async () => {
  // 1. THE MAP TILES TABLE (Tracks memory, 14-day limits, and frequent places)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS MapTiles (
      tile_id TEXT PRIMARY KEY,
      last_accessed INTEGER,
      visit_count INTEGER DEFAULT 1,
      is_protected BOOLEAN DEFAULT 0
    );
  `);

  // 2. THE EMERGENCY POI TABLE (Featherweight data: only hospitals, police, mechanics)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS EmergencyServices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tile_id TEXT,
      type TEXT,
      name TEXT,
      lat REAL,
      lon REAL,
      phone TEXT,
      FOREIGN KEY(tile_id) REFERENCES MapTiles(tile_id) ON DELETE CASCADE
    );
  `);
  console.log("Smart Vault Initialized.");
};

// ==========================================
// THE 9-TILE SAFETY NET ENGINE
// ==========================================

// Helper: Converts GPS to a rough 10kmx10km "Tile ID" (e.g., "lat25.6_lon85.1")
export const getTileId = (lat, lon) => {
  return `lat${Math.round(lat * 10)}_lon${Math.round(lon * 10)}`;
};

// Generates the current tile + the 8 surrounding tiles
export const get9TileSafetyNet = (lat, lon) => {
  const tiles = [];
  const offset = 0.1; // roughly 10-11km at the equator
  
  for (let dLat = -offset; dLat <= offset; dLat += offset) {
    for (let dLon = -offset; dLon <= offset; dLon += offset) {
      tiles.push(getTileId(lat + dLat, lon + dLon));
    }
  }
  return tiles;
};

// ==========================================
// MEMORY MANAGEMENT (The Auto-Cleanup)
// ==========================================

export const performMemoryCleanup = async () => {
  const now = Date.now();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const cutoffTime = now - fourteenDaysMs;

  console.log("Running Vault Maintenance...");

  // 1. The 14-Day Cleanup: Delete unprotected tiles older than 14 days
  await db.runAsync(`
    DELETE FROM MapTiles 
    WHERE is_protected = 0 AND last_accessed < ?
  `, [cutoffTime]);

  // 2. The Emergency Brake: If we have more than 10 tiles, delete the oldest unpinned one
  const tileCountRow = await db.getFirstAsync(`SELECT COUNT(*) as count FROM MapTiles`);
  
  if (tileCountRow.count > 10) { 
    console.log("Storage hitting limit! Engaging Emergency Brake...");
    await db.runAsync(`
      DELETE FROM MapTiles 
      WHERE is_protected = 0 
      ORDER BY last_accessed ASC 
      LIMIT 1
    `);
  }
};

// ==========================================
// THE SILENT CO-PILOT (Background Sync)
// ==========================================

// ==========================================
// THE SILENT CO-PILOT (Aggressive Multi-Server Sync)
// ==========================================

// Helper function to create a small delay between retries
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const syncAreaIfNeeded = async (lat, lon) => {
  const currentTileId = getTileId(lat, lon);
  const now = Date.now();

  // 1. Check if we already have this tile
  const existingTile = await db.getFirstAsync(
    `SELECT * FROM MapTiles WHERE tile_id = ?`, 
    [currentTileId]
  );

  if (existingTile) {
    const newVisitCount = existingTile.visit_count + 1;
    const isProtected = newVisitCount >= 3 ? 1 : 0; 
    
    await db.runAsync(`
      UPDATE MapTiles 
      SET last_accessed = ?, visit_count = ?, is_protected = ? 
      WHERE tile_id = ?
    `, [now, newVisitCount, isProtected, currentTileId]);
    
    console.log(`Tile ${currentTileId} updated. Protected status: ${isProtected}`);
    return; // Data already exists, exit early!
  }

  // 2. We don't have this tile! Time to fetch.
  console.log(`Entering new territory. Downloading Safety Net for ${currentTileId}...`);
  
  try {
    await performMemoryCleanup();

    const overpassQuery = `
      [out:json][timeout:10];
      (
        node["amenity"="hospital"](around:5000, ${lat}, ${lon});
        node["amenity"="police"](around:5000, ${lat}, ${lon});
      );
      out body;
    `;

    // THE AGGRESSIVE RETRY PROTOCOL
    // A list of global fallback servers
    const overpassServers = [
      'https://overpass-api.de/api/interpreter',       // Main Server (Germany)
      'https://lz4.overpass-api.de/api/interpreter',   // Backup 1 (Germany)
      'https://overpass.kumi.systems/api/interpreter', // Backup 2 (Russia)
      'https://overpass.osm.ch/api/interpreter'        // Backup 3 (Switzerland)
    ];

    let downloadedData = null;
    let syncSuccess = false;

    for (let i = 0; i < overpassServers.length; i++) {
      try {
        console.log(`Attempting Server ${i + 1}: ${overpassServers[i]}`);
        
        const response = await fetch(`${overpassServers[i]}?data=${encodeURIComponent(overpassQuery)}`, {
            // Force a 10 second timeout so we don't hang forever on a bad server
            signal: AbortSignal.timeout(10000) 
        });

        if (!response.ok) {
            throw new Error(`Server rejected connection (Status: ${response.status})`);
        }

        downloadedData = await response.json();
        syncSuccess = true;
        console.log(`Success! Data acquired from Server ${i + 1}.`);
        break; // We got the data, instantly exit the retry loop!

      } catch (error) {
        console.log(`Server ${i + 1} failed. Pivoting to next server...`);
        await sleep(1500); // Wait 1.5 seconds so we don't trigger spam filters
      }
    }

    // If we looped through all 4 servers and STILL failed
    if (!syncSuccess || !downloadedData) {
        throw new Error("All global map servers are currently overloaded.");
    }

    // 3. Save the successfully fetched data to the Vault
    await db.runAsync(`
      INSERT INTO MapTiles (tile_id, last_accessed, visit_count, is_protected) 
      VALUES (?, ?, 1, 0)
    `, [currentTileId, now]);

    for (const element of downloadedData.elements) {
      if (element.type === 'node') {
        const name = element.tags?.name || "Unknown Facility";
        const type = element.tags?.amenity || "emergency";
        
        await db.runAsync(`
          INSERT INTO EmergencyServices (tile_id, type, name, lat, lon) 
          VALUES (?, ?, ?, ?, ?)
        `, [currentTileId, type, name, element.lat, element.lon]);
      }
    }
    console.log(`Safety Net secured. ${downloadedData.elements.length} emergency POIs saved offline.`);

  } catch (error) {
    console.log("Background sync completely failed:", error.message);
  }
};
// ==========================================
// FRONTEND HELPER (To display data on screen)
// ==========================================
export const getLocalEmergencyServices = async (lat, lon) => {
  const currentTileId = getTileId(lat, lon);
  // Fetch all hospitals saved in the current 10km tile
  const result = await db.getAllAsync(
    `SELECT * FROM EmergencyServices WHERE tile_id = ? LIMIT 5`, 
    [currentTileId]
  );
  return result;
};