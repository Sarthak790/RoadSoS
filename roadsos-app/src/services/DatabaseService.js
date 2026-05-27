import * as SQLite from 'expo-sqlite';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { DeviceEventEmitter } from 'react-native';

// 🚨 1. IMPORT THE PRE-PACKAGED CITY DATA
// Ensure this path correctly points to where you created cities_seed.json
import seedData from '../../assets/data/cities_seed.json'; 

const db = SQLite.openDatabaseSync('roadsos_global_vault.db');

export const initializeSmartVault = async () => {
  // Explicitly enable Foreign Keys
  await db.execAsync('PRAGMA foreign_keys = ON;');

  // Create Tables
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS MapTiles (
      tile_id TEXT PRIMARY KEY,
      last_accessed INTEGER,
      visit_count INTEGER DEFAULT 1,
      is_protected BOOLEAN DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS EmergencyServices (
      id TEXT PRIMARY KEY,
      tile_id TEXT,
      type TEXT,
      name TEXT,
      lat REAL,
      lon REAL,
      phone TEXT,
      FOREIGN KEY(tile_id) REFERENCES MapTiles(tile_id) ON DELETE CASCADE
    );
  `);

  // 🚨 2. THE SEED INJECTION: Check if this is the very first boot
  const hasSeeded = await db.getFirstAsync(`SELECT * FROM MapTiles LIMIT 1`);
  
  if (!hasSeeded && seedData && seedData.tiles) {
    console.log("First boot detected! Injecting offline Top Cities...");
    const now = Date.now();
    
    await db.withTransactionAsync(async () => {
      // Inject the protected tiles (They won't be deleted by the 14-day cleanup!)
      for (const tId of seedData.tiles) {
        await db.runAsync(`
          INSERT INTO MapTiles (tile_id, last_accessed, visit_count, is_protected) 
          VALUES (?, ?, 100, 1)
        `, [tId, now]);
      }
      
      // Inject the actual hospitals and police stations
      if (seedData.services) {
        for (const s of seedData.services) {
          await db.runAsync(`
            INSERT INTO EmergencyServices (id, tile_id, type, name, lat, lon, phone) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [s.id, s.tile_id, s.type, s.name, s.lat, s.lon, s.phone || null]);
        }
      }
    });
    console.log("Pre-packaged Offline Cities successfully locked in the Vault.");
  } else {
    console.log("Smart Vault Initialized (Already Seeded).");
  }
};

export const getTileId = (lat, lon) => `lat${Math.round(lat * 10)}_lon${Math.round(lon * 10)}`;

export const get9TileSafetyNet = (lat, lon) => {
  const tiles = [];
  const offset = 0.1; 
  for (let dLat = -offset; dLat <= offset; dLat += offset) {
    for (let dLon = -offset; dLon <= offset; dLon += offset) {
      tiles.push(getTileId(lat + dLat, lon + dLon));
    }
  }
  return tiles;
};

export const isTileReadyOffline = async (lat, lon) => {
  const tileId = getTileId(lat, lon);
  const now = Date.now();
  const STALE_DATA_THRESHOLD = now - (30 * 24 * 60 * 60 * 1000); 

  try {
    const tileRecord = await db.getFirstAsync(
      `SELECT last_accessed FROM MapTiles WHERE tile_id = ?`, 
      [tileId]
    );

    if (!tileRecord || tileRecord.last_accessed < STALE_DATA_THRESHOLD) {
      return false; 
    }
    return true; 
  } catch (error) {
    console.log("Error checking offline tile status:", error);
    return false;
  }
};

export const performMemoryCleanup = async () => {
  const now = Date.now();
  const cutoffTime = now - (14 * 24 * 60 * 60 * 1000); 

  await db.runAsync(
    `DELETE FROM MapTiles WHERE is_protected = 0 AND last_accessed < ?`, 
    [cutoffTime]
  );

  const tileCountRow = await db.getFirstAsync(`SELECT COUNT(*) as count FROM MapTiles`);
  
  if (tileCountRow && tileCountRow.count > 100) { 
    await db.runAsync(`DELETE FROM MapTiles WHERE is_protected = 0 ORDER BY last_accessed ASC LIMIT 1`);
  }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let isSyncInProgress = false;

export const syncAreaIfNeeded = async (lat, lon) => {
  if (isSyncInProgress) {
    console.log("🚦 Smart Vault is currently busy. Skipping duplicate GPS trigger.");
    return;
  }
  isSyncInProgress = true; 

  try {
    const now = Date.now();
    const STALE_DATA_THRESHOLD = now - (30 * 24 * 60 * 60 * 1000); 

    const lastLoc = await Location.getLastKnownPositionAsync({}).catch(() => null);
    const speedKmH = (lastLoc?.coords?.speed || 0) * 3.6;
    const heading = lastLoc?.coords?.heading || 0;

    let targetLat = lat;
    let targetLon = lon;

    if (speedKmH > 40) {
      const rad = (heading * Math.PI) / 180;
      targetLat += 0.1 * Math.cos(rad);
      targetLon += 0.1 * Math.sin(rad);
      console.log(`Highway speeds detected. Shifting safety net forward.`);
    }

    const nineTiles = get9TileSafetyNet(targetLat, targetLon);
    const missingOrStaleTiles = [];
    
    for (const tId of nineTiles) {
      const existingTile = await db.getFirstAsync(`SELECT * FROM MapTiles WHERE tile_id = ?`, [tId]);
      
      if (existingTile) {
        if (existingTile.last_accessed < STALE_DATA_THRESHOLD) {
            missingOrStaleTiles.push(tId);
        } else {
            const newVisitCount = existingTile.visit_count + 1;
            const isProtected = newVisitCount >= 3 ? 1 : 0;
            await db.runAsync(`UPDATE MapTiles SET last_accessed = ?, visit_count = ?, is_protected = ? WHERE tile_id = ?`, 
              [now, newVisitCount, isProtected, tId]);
        }
      } else {
        missingOrStaleTiles.push(tId);
      }
    }

    if (missingOrStaleTiles.length === 0) {
        console.log("[Watcher] All 9 tiles are fresh and secured. No network needed.");
        return; 
    }

    const networkState = await NetInfo.fetch();
    if (!networkState.isConnected) {
        console.log("[Watcher] Device is offline. Relying strictly on existing Vault data.");
        return; 
    }

    await performMemoryCleanup();
    
    const minLat = targetLat - 0.15;
    const minLon = targetLon - 0.15;
    const maxLat = targetLat + 0.15;
    const maxLon = targetLon + 0.15;

    const overpassQuery = `[out:json][timeout:25]; (nwr["amenity"~"^(hospital|police)$"](${minLat},${minLon},${maxLat},${maxLon});); out center;`;
    
    const overpassServers = [
      'https://overpass-api.de/api/interpreter', 
      'https://lz4.overpass-api.de/api/interpreter', 
      'https://overpass.kumi.systems/api/interpreter'
    ];

    let downloadedData = null;
    for (let i = 0; i < overpassServers.length; i++) {
      try {
        console.log(`[Watcher] Contacting OSM Server ${i}...`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); 
        
        const response = await fetch(overpassServers[i], {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'User-Agent': 'RoadSOS-App/1.0 (contact: akr62225@gmail.com)',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `data=${encodeURIComponent(overpassQuery)}`
        });
        
        clearTimeout(timeoutId);

        if (response.ok) {
          downloadedData = await response.json();
          console.log(`[Watcher] Success on Server ${i}!`);
          break; 
        } else {
          console.log(`[Watcher] Server ${i} rejected request. Status: ${response.status}`);
          await sleep(1500); 
        }
      } catch (error) { 
        if (error.name === 'AbortError') {
          console.log(`[Watcher] Server ${i} timed out after 25 seconds.`);
        } else {
          console.log(`[Watcher] Server ${i} failed: ${error.message}`);
        }
        await sleep(1500); 
      }
    }

    if (!downloadedData || !downloadedData.elements) {
       console.log("⚠️ All OSM servers failed to provide data.");
       return; 
    }

    await db.withTransactionAsync(async () => {
      for (const tId of nineTiles) {
        await db.runAsync(`
          INSERT INTO MapTiles (tile_id, last_accessed, visit_count, is_protected) 
          VALUES (?, ?, 1, 0)
          ON CONFLICT(tile_id) DO UPDATE SET 
          last_accessed = excluded.last_accessed,
          visit_count = visit_count + 1
        `, [tId, now]);
      }

      for (const el of downloadedData.elements) {
        const pointLat = el.lat || el.center?.lat;
        const pointLon = el.lon || el.center?.lon;
        
        if (!pointLat || !pointLon) continue; 

        const accurateTileId = getTileId(pointLat, pointLon);
        
        await db.runAsync(`
          INSERT OR IGNORE INTO EmergencyServices (id, tile_id, type, name, lat, lon) 
          VALUES (?, ?, ?, ?, ?, ?)
        `, [el.id.toString(), accurateTileId, el.tags.amenity, el.tags.name || "Emergency Facility", pointLat, pointLon]);
      }
    });

    console.log(`Safety Net secured. Vault updated with ${downloadedData.elements.length} locations.`);
    
    const syncedTileId = getTileId(targetLat, targetLon);
    DeviceEventEmitter.emit('VaultUpdated', syncedTileId);

  } catch (error) {
    console.log("Background sync failed:", error.message);
  } finally {
    isSyncInProgress = false;
  }
};


// The Math Engine for precise real-world distances
const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
  return R * c; 
};

// 🚨 3. THE UPGRADED 9-TILE RETRIEVAL FUNCTION
export const getLocalEmergencyServices = async (lat, lon) => {
  try {
    // We grab the 9 tiles encompassing the user's location (approx 30x30km radius)
    const nineTiles = get9TileSafetyNet(lat, lon);
    
    // Create the SQLite IN clause dynamically (e.g., "?, ?, ?...")
    const placeholders = nineTiles.map(() => '?').join(',');
    
    // Fetch ALL services inside the entire 9-tile buffer zone
    const rows = await db.getAllAsync(`SELECT * FROM EmergencyServices WHERE tile_id IN (${placeholders})`, nineTiles);
    
    // Inject the 'distance' property calculated against the user's exact coordinates
    const processedServices = rows.map(row => ({
        ...row,
        distance: getDistanceFromLatLonInKm(lat, lon, row.lat, row.lon)
    }));

    // Sort the entire batch so the absolute closest facilities are at the top
    processedServices.sort((a, b) => a.distance - b.distance);
    
    // Return the 5 absolute closest
    return processedServices.slice(0, 5);
    
  } catch (error) {
    console.error("Database Retrieval Failed:", error);
    return [];
  }
};