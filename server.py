import http.server
import json
import os
import urllib.parse
import pymongo

# Load environment variables from .env if it exists
def load_env():
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_file):
        with open(env_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    parts = line.split('=', 1)
                    if len(parts) == 2:
                        key, val = parts
                        # Clean quotes if any
                        val_str = val.strip().strip("'").strip('"')
                        os.environ[parts[0].strip()] = val_str

load_env()

PORT = int(os.environ.get('PORT', 8080))
DB_FILE = 'database.json'
MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb+srv://Time_Clock_HR:OWE5054P@timeclock.daps9qi.mongodb.net/time_clock?appName=TimeClock')

# Initialize MongoDB Client
print(f"Connecting to MongoDB at {MONGODB_URI}...")
try:
    import certifi
    client = pymongo.MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, tlsCAFile=certifi.where())
    # Check if a database is specified in connection string
    try:
        db = client.get_default_database()
        if db is None:
            db = client['time_clock']
    except Exception:
        db = client['time_clock']
    # Trigger a quick connection test
    client.server_info()
    print("Connected to MongoDB successfully!")
except Exception as conn_err:
    print(f"CRITICAL: Could not connect to MongoDB: {conn_err}")
    print("Please make sure MongoDB is running or configure MONGODB_URI in your .env file.")
    # We will let the server continue, but operations will raise errors

# Collections helper lists
LIST_COLLECTIONS = ['employees', 'attendance', 'leaves', 'holidays', 'payrolls', 'notifications', 'emails', 'outside_work']

# Seed MongoDB if empty and database.json exists
def seed_database():
    try:
        # Check if we have any data in the main collection (employees)
        if db.employees.count_documents({}) == 0:
            print("MongoDB collection 'employees' is empty. Attempting to seed from database.json...")
            if os.path.exists(DB_FILE):
                with open(DB_FILE, 'r', encoding='utf-8') as f:
                    seed_data = json.load(f)
                if isinstance(seed_data, dict):
                    # Seed arrays
                    for key in LIST_COLLECTIONS:
                        if key in seed_data and isinstance(seed_data[key], list) and seed_data[key]:
                            # Clear collection just in case
                            db[key].delete_many({})
                            db[key].insert_many(seed_data[key])
                            print(f"Seeded collection '{key}' with {len(seed_data[key])} documents.")
                    
                    # Seed settings (geofence, booted)
                    if 'geofence' in seed_data:
                        db.settings.replace_one({"key": "geofence"}, {"key": "geofence", "value": seed_data['geofence']}, upsert=True)
                        print("Seeded 'geofence' setting.")
                    if 'booted' in seed_data:
                        db.settings.replace_one({"key": "booted"}, {"key": "booted", "value": seed_data['booted']}, upsert=True)
                        print("Seeded 'booted' setting.")
                    print("MongoDB database seeding finished.")
            else:
                print(f"No {DB_FILE} found to seed database. Starting empty.")
        else:
            print("MongoDB database is already seeded (employees found).")
    except Exception as e:
        print(f"Error during seeding database: {e}")

try:
    seed_database()
except Exception as e:
    print(f"Failed to run seed check: {e}")

class ApexFlowHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for local cross-port testing
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "OK")
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/data':
            try:
                # Fetch all collections and build response payload
                payload = {}
                for col in LIST_COLLECTIONS:
                    payload[col] = list(db[col].find({}, {"_id": 0}))
                
                # Fetch settings
                geofence_doc = db.settings.find_one({"key": "geofence"}, {"_id": 0})
                payload["geofence"] = geofence_doc["value"] if geofence_doc else {"lat": None, "lng": None, "radius": 200}
                
                booted_doc = db.settings.find_one({"key": "booted"}, {"_id": 0})
                payload["booted"] = booted_doc["value"] if booted_doc else False
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
        else:
            # Fall back to standard static file server
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/save':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                
                # Parse and write to MongoDB
                payload = json.loads(post_data.decode('utf-8'))
                
                for key, val in payload.items():
                    if key in LIST_COLLECTIONS:
                        if isinstance(val, list):
                            # Overwrite collection contents with new synced array
                            db[key].delete_many({})
                            if val:
                                db[key].insert_many(val)
                    elif key in ['geofence', 'booted']:
                        db.settings.replace_one({"key": key}, {"key": key, "value": val}, upsert=True)
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8')) 
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == '__main__':
    # Set workspace directory as current directory
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server_address = ('', PORT)
    httpd = http.server.HTTPServer(server_address, ApexFlowHandler)
    print(f"Time Clock Database & Web Server running at http://localhost:{PORT}")
    httpd.serve_forever()
