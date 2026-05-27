import * as SQLite from 'expo-sqlite';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { DeviceEventEmitter } from 'react-native'; // 🚨 Added to alert UI when vault updates

const db = SQLite.openDatabaseSync('roadsos_global_vault.db');

export const initializeSmartVault = async () => {
  // Explicitly enable Foreign Keys to ensure ON DELETE CASCADE works properly
  await db.execAsync('PRAGMA foreign_keys = ON;');

  // 1. THE MAP TILES TABLE (Memory, limits, frequent places)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS MapTiles (
      tile_id TEXT PRIMARY KEY,
      last_accessed INTEGER,
      visit_count INTEGER DEFAULT 1,
      is_protected BOOLEAN DEFAULT 0
    );
  `);
                                                       
  // 2. THE EMERGENCY POI TABLE (No Autoincrement! Uses unique OSM ID to prevent duplicates)
  await db.execAsync(`
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
  console.log("Smart Vault Initialized.");
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

// 🚨 NEW HELPER: Checks if a specific tile is downloaded AND fresh
export const isTileReadyOffline = async (lat, lon) => {
  const tileId = getTileId(lat, lon);
  const now = Date.now();
  const STALE_DATA_THRESHOLD = now - (30 * 24 * 60 * 60 * 1000); // 30 Days

  try {
    const tileRecord = await db.getFirstAsync(
      `SELECT last_accessed FROM MapTiles WHERE tile_id = ?`, 
      [tileId]
    );

    // If the tile doesn't exist, or if it's older than 30 days, it's NOT ready.
    if (!tileRecord || tileRecord.last_accessed < STALE_DATA_THRESHOLD) {
      return false; 
    }

    // The tile exists and is fresh! Offline buffer is ready.
    return true; 

  } catch (error) {
    console.log("Error checking offline tile status:", error);
    return false;
  }
};

export const performMemoryCleanup = async () => {
  const now = Date.now();
  // 14 days cleanup for unprotected tiles
  const cutoffTime = now - (14 * 24 * 60 * 60 * 1000); 

  await db.runAsync(
    `DELETE FROM MapTiles WHERE is_protected = 0 AND last_accessed < ?`, 
    [cutoffTime]
  );

  const tileCountRow = await db.getFirstAsync(`SELECT COUNT(*) as count FROM MapTiles`);
  
  // Enforcing a maximum tile limit
  if (tileCountRow && tileCountRow.count > 100) { 
    await db.runAsync(`DELETE FROM MapTiles WHERE is_protected = 0 ORDER BY last_accessed ASC LIMIT 1`);
  }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const syncAreaIfNeeded = async (lat, lon) => {
  try {
    const now = Date.now();
    const STALE_DATA_THRESHOLD = now - (30 * 24 * 60 * 60 * 1000); // 30 Days

    // 1. Predictive Biasing (The Speed Gate)
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

    // 2. Hometown Protection & Stale Data Check
    const nineTiles = get9TileSafetyNet(targetLat, targetLon);
    const missingOrStaleTiles = [];
    
    for (const tId of nineTiles) {
      const existingTile = await db.getFirstAsync(`SELECT * FROM MapTiles WHERE tile_id = ?`, [tId]);
      
      if (existingTile) {
        // If the tile exists but is older than 30 days, flag it for a re-download!
        if (existingTile.last_accessed < STALE_DATA_THRESHOLD) {
            missingOrStaleTiles.push(tId);
        } else {
            // Tile is fresh. Update it so it doesn't get cleaned up.
            const newVisitCount = existingTile.visit_count + 1;
            const isProtected = newVisitCount >= 3 ? 1 : 0;
            await db.runAsync(`UPDATE MapTiles SET last_accessed = ?, visit_count = ?, is_protected = ? WHERE tile_id = ?`, 
              [now, newVisitCount, isProtected, tId]);
        }
      } else {
        missingOrStaleTiles.push(tId);
      }
    }

    // If all 9 grids are in the vault AND they are fresh, stop here!
    if (missingOrStaleTiles.length === 0) {
        console.log("[Watcher] All 9 tiles are fresh and secured. No network needed.");
        return; 
    }

    // 3. FAIL-FAST NETWORK CHECK (Don't waste battery if offline)
    const networkState = await NetInfo.fetch();
    if (!networkState.isConnected) {
        console.log("[Watcher] Device is offline. Relying strictly on existing Vault data.");
        return; 
    }

    // Strict Bounding Box Fetch
    await performMemoryCleanup();
    
    // Adjusted bounding box to cover the entire 9-Tile Grid (approx 30km x 30km)
    const minLat = targetLat - 0.15;
    const minLon = targetLon - 0.15;
    const maxLat = targetLat + 0.15;
    const maxLon = targetLon + 0.15;

    // Overpass query configured to catch nodes, ways, and relations
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
        const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 seconds
        
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

    // 4. Atomic Commit
    await db.withTransactionAsync(async () => {
      
      // 🚨 FIX: Force update ALL 9 tiles in the grid to show they were just synced
      for (const tId of nineTiles) {
        await db.runAsync(`
          INSERT INTO MapTiles (tile_id, last_accessed, visit_count, is_protected) 
          VALUES (?, ?, 1, 0)
          ON CONFLICT(tile_id) DO UPDATE SET 
          last_accessed = excluded.last_accessed,
          visit_count = visit_count + 1
        `, [tId, now]);
      }

      // Sort the downloaded hospitals into their correct tile buckets
      for (const el of downloadedData.elements) {
        const pointLat = el.lat || el.center?.lat;
        const pointLon = el.lon || el.center?.lon;
        
        if (!pointLat || !pointLon) continue; 

        // 🚨 This is where the magic happens: Sorting data into the exact tile ID
        const accurateTileId = getTileId(pointLat, pointLon);
        
        await db.runAsync(`
          INSERT OR IGNORE INTO EmergencyServices (id, tile_id, type, name, lat, lon) 
          VALUES (?, ?, ?, ?, ?, ?)
        `, [el.id.toString(), accurateTileId, el.tags.amenity, el.tags.name || "Emergency Facility", pointLat, pointLon]);
      }
    });

    console.log(`Safety Net secured. Vault updated with ${downloadedData.elements.length} locations.`);
    
    // 🚨 NEW: Shoot the flare to the UI so it knows to re-render!
    const syncedTileId = getTileId(targetLat, targetLon);
    DeviceEventEmitter.emit('VaultUpdated', syncedTileId);

  } catch (error) {
    console.log("Background sync failed:", error.message);
  }
};

export const getLocalEmergencyServices = async (lat, lon) => {
  const currentTileId = getTileId(lat, lon);
  return await db.getAllAsync(`SELECT * FROM EmergencyServices WHERE tile_id = ? LIMIT 5`, [currentTileId]);
};