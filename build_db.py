import json
import sqlite3

def build_database():
    # 1. Connect to SQLite (this creates the file if it doesn't exist)
    conn = sqlite3.connect('roadsos_patna.db')
    cursor = conn.cursor()

    # 2. Create the table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS emergency_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_type TEXT,
        name TEXT,
        latitude REAL,
        longitude REAL,
        phone TEXT
    )
    ''')

    # Clear existing data if you run the script multiple times
    cursor.execute('DELETE FROM emergency_services')

    # 3. Load the GeoJSON data
    try:
        with open('export.geojson', 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print("Error: Make sure your file is named 'export.geojson' and is in the same directory.")
        return

    # 4. Parse and Insert Data
    inserted_count = 0
    for feature in data.get('features', []):
        geom = feature.get('geometry', {})
        props = feature.get('properties', {})
        
        # GeoJSON coordinates are always [longitude, latitude]
        if geom.get('type') == 'Point':
            lon, lat = geom.get('coordinates', [None, None])
            
            # Categorize the service based on OpenStreetMap tags
            amenity = props.get('amenity')
            shop = props.get('shop')
            
            if amenity in ['hospital', 'clinic']:
                service_type = 'hospital'
            elif amenity == 'police':
                service_type = 'police'
            elif shop in ['car_repair', 'tyres']:
                service_type = 'mechanic'
            else:
                service_type = 'unknown'

            # Grab Name and Phone (OSM data often has missing fields, so we use fallbacks)
            name = props.get('name', 'Unknown')
            phone = props.get('phone', 'Not Available')

            cursor.execute('''
            INSERT INTO emergency_services (service_type, name, latitude, longitude, phone)
            VALUES (?, ?, ?, ?, ?)
            ''', (service_type, name, lat, lon, phone))
            
            inserted_count += 1

    # 5. Save and Close
    conn.commit()
    conn.close()
    print(f"Success! Database 'roadsos_patna.db' created with {inserted_count} emergency contacts.")

if __name__ == "__main__":
    build_database()