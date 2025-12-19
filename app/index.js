import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Alert, Switch, Platform, AppState } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';

// --- CONSTANTS ---
const LOCATION_TASK_NAME = 'background-location-task';
const STORAGE_KEY = '@gps_alarms';

// --- NOTIFICATION HANDLER (Foreground) ---
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// --- HELPER: Haversine Distance ---
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; 
  const φ1 = lat1 * (Math.PI / 180);
  const φ2 = lat2 * (Math.PI / 180);
  const Δφ = (lat2 - lat1) * (Math.PI / 180);
  const Δλ = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; 
};

// --- BACKGROUND TASK (The "Engine" that runs while locked) ---
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error("Background task error:", error);
    return;
  }
  if (data) {
    const { locations } = data;
    const currentLoc = locations[0]; // The latest GPS point
    
    // 1. Read Alarms from Storage
    const jsonValue = await AsyncStorage.getItem(STORAGE_KEY);
    const savedAlarms = jsonValue != null ? JSON.parse(jsonValue) : [];

    let alarmsUpdated = false;
    const now = Date.now();

    const updatedAlarms = savedAlarms.map(alarm => {
      // Skip logic: Not active? Already rang? Snoozed?
      if (!alarm.active || alarm.triggered) return alarm;
      if (alarm.snoozedUntil && now < alarm.snoozedUntil) return alarm;

      const dist = getDistance(
        currentLoc.coords.latitude, currentLoc.coords.longitude,
        alarm.latitude, alarm.longitude
      );

      // Trigger Logic
      if (dist <= alarm.radius) {
        // Send Notification
        Notifications.scheduleNotificationAsync({
          content: {
            title: "📍 YOU HAVE ARRIVED!",
            body: `Wake up! You are within range of ${alarm.name}`,
            sound: 'default', // Make sure you have a sound file if needed, or use default
            categoryIdentifier: 'alarm-actions', // This attaches the buttons (Snooze/Stop)
            data: { alarmId: alarm.id }
          },
          trigger: null, // Send immediately
        });
        
        alarmsUpdated = true;
        return { ...alarm, triggered: true, active: false }; // Turn it off
      }
      return alarm;
    });

    // 2. Save changes if any alarm triggered
    if (alarmsUpdated) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updatedAlarms));
    }
  }
});

// --- MAIN APP COMPONENT ---
export default function App() {
  const [location, setLocation] = useState(null);
  const [alarms, setAlarms] = useState([]);
  const [selectedCoord, setSelectedCoord] = useState(null); 
  const [sliderValue, setSliderValue] = useState(500); 
  const [isKm, setIsKm] = useState(false); 
  
  const mapRef = useRef(null);
  const responseListener = useRef();

  // --- INITIALIZATION ---
  useEffect(() => {
    loadAlarms();
    requestPermissions();
    setupNotificationCategories();

    // Listen for interactions (User presses "Snooze" on lock screen)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const actionId = response.actionIdentifier;
      const alarmId = response.notification.request.content.data.alarmId;

      if (actionId === 'snooze') {
        snoozeAlarm(alarmId);
      } else if (actionId === 'stop') {
        // Already handled by background task (set to triggered), but we reload UI
        loadAlarms();
      }
    });

    return () => {
      // --- FIX IS HERE ---
      // We check if it exists, then call .remove() directly on the object
      if (responseListener.current) {
        responseListener.current.remove(); 
      }
    };
  }, []);

  // Save alarms whenever they change in the UI
  useEffect(() => {
    const save = async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(alarms));
    };
    save();
  }, [alarms]);

  // --- PERMISSIONS & SETUP ---
  const requestPermissions = async () => {
    // 1. Foreground
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      Alert.alert("Permission Error", "Location permission is required.");
      return;
    }

    // 2. Background
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      Alert.alert("Background Error", "Background location is disabled. Alarms won't work if phone is locked.");
    }

    // 3. Start Background Task
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 5000, // Check every 5 seconds
      distanceInterval: 10, // Or every 10 meters
      showsBackgroundLocationIndicator: true, // Required for iOS
      foregroundService: {
        notificationTitle: "GPS Alarm Running",
        notificationBody: "Monitoring your location..."
      }
    });

    // 4. Start Foreground Watcher (for UI updates)
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
      (loc) => setLocation(loc)
    );
  };

  const setupNotificationCategories = async () => {
    await Notifications.setNotificationCategoryAsync('alarm-actions', [
      { identifier: 'snooze', buttonTitle: '💤 Snooze 5m', options: { opensAppToForeground: false } },
      { identifier: 'stop', buttonTitle: '✅ Stop Alarm', options: { isDestructive: true, opensAppToForeground: true } },
    ]);
  };

  const loadAlarms = async () => {
    const jsonValue = await AsyncStorage.getItem(STORAGE_KEY);
    if (jsonValue != null) setAlarms(JSON.parse(jsonValue));
  };

  // --- LOGIC: SNOOZE ---
  const snoozeAlarm = (id) => {
    setAlarms(prev => prev.map(a => {
      if (a.id === id) {
        return { 
          ...a, 
          triggered: false, 
          active: true, 
          snoozedUntil: Date.now() + (5 * 60 * 1000) // 5 Minutes
        }; 
      }
      return a;
    }));
    Alert.alert("Snoozed", "We will wake you again in 5 minutes if you are still here.");
  };

  // --- UI ACTIONS ---
  const handleAddAlarm = () => {
    if (!selectedCoord) return Alert.alert("Select Location", "Tap the map first.");
    const r = isKm ? sliderValue * 1000 : sliderValue;
    const newAlarm = {
      id: Date.now().toString(),
      name: `Alarm #${alarms.length + 1}`,
      latitude: selectedCoord.latitude,
      longitude: selectedCoord.longitude,
      radius: r,
      active: true,
      triggered: false,
      snoozedUntil: 0
    };
    setAlarms([...alarms, newAlarm]);
    setSelectedCoord(null);
  };

  const deleteAlarm = (id) => setAlarms(alarms.filter(a => a.id !== id));

  const toggleAlarm = (id) => {
    setAlarms(alarms.map(a => 
      a.id === id ? { ...a, active: !a.active, triggered: !a.active ? false : a.triggered } : a
    ));
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        showsUserLocation={true}
        onPress={(e) => setSelectedCoord(e.nativeEvent.coordinate)}
        initialRegion={{
          latitude: location ? location.coords.latitude : 28.6139,
          longitude: location ? location.coords.longitude : 77.2090,
          latitudeDelta: 0.05, longitudeDelta: 0.05,
        }}
      >
        {/* Render Saved Alarms */}
        {alarms.map((alarm) => (
          <React.Fragment key={alarm.id}>
            <Marker coordinate={alarm} pinColor={alarm.active ? "green" : "gray"} />
            <Circle center={alarm} radius={alarm.radius} 
              fillColor={alarm.active ? "rgba(0, 255, 0, 0.1)" : "rgba(100,100,100,0.1)"}
              strokeColor={alarm.active ? "green" : "gray"} />
          </React.Fragment>
        ))}

        {/* Render Selection & Preview Circle */}
        {selectedCoord && (
          <>
            <Marker coordinate={selectedCoord} pinColor="blue" />
            <Circle 
              center={selectedCoord} 
              radius={isKm ? sliderValue * 1000 : sliderValue} 
              fillColor="rgba(0, 122, 255, 0.2)" 
              strokeColor="#007AFF" 
              strokeWidth={2}
              lineDashPattern={[5, 5]} 
            />
          </>
        )}
      </MapView>

      <View style={styles.panel}>
        <View style={styles.header}>
           <Text style={styles.gpsText}>
             {location ? "GPS Active • Background ON" : "Locating..."}
           </Text>
           {selectedCoord && 
             <TouchableOpacity onPress={() => setSelectedCoord(null)} style={styles.clearBtn}>
               <Text style={styles.clearBtnText}>Cancel</Text>
             </TouchableOpacity>
           }
        </View>

        <View style={styles.controlBox}>
          <View style={styles.sliderRow}>
            <Text style={styles.label}>
              Radius: {(isKm ? sliderValue : sliderValue).toFixed(1)} {isKm ? 'KM' : 'm'}
            </Text>
            <TouchableOpacity onPress={() => setIsKm(!isKm)} style={styles.unitBtn}>
              <Text style={styles.unitText}>{isKm ? "Use Meters" : "Use KM"}</Text>
            </TouchableOpacity>
          </View>

          <Slider
            style={{width: '100%', height: 40}}
            minimumValue={isKm ? 0.1 : 50}
            maximumValue={isKm ? 5 : 2000}
            step={isKm ? 0.1 : 50}
            value={sliderValue}
            onValueChange={setSliderValue}
            minimumTrackTintColor="#007AFF"
            thumbTintColor="#007AFF"
          />

          <TouchableOpacity 
            style={[styles.bigAddBtn, !selectedCoord && {backgroundColor:'#ccc'}]} 
            onPress={handleAddAlarm} 
            disabled={!selectedCoord}
          >
            <Text style={styles.bigAddBtnText}>{selectedCoord ? "SET ALARM" : "TAP MAP TO START"}</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={alarms}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={[styles.card, (!item.active || item.triggered) && styles.cardInactive]}>
              <View style={{flex: 1}}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.cardSub}>
                  {item.triggered ? "ARRIVED" : item.snoozedUntil > Date.now() ? "💤 Snoozed" : "Monitoring"} • {item.radius.toFixed(0)}m
                </Text>
              </View>
              <View style={styles.cardActions}>
                <Switch value={item.active} onValueChange={() => toggleAlarm(item.id)} />
                <TouchableOpacity onPress={() => deleteAlarm(item.id)}><Text style={{fontSize: 20}}>🗑️</Text></TouchableOpacity>
              </View>
            </View>
          )}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  map: { width: '100%', height: '50%' },
  panel: { flex: 1, padding: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  gpsText: { fontSize: 12, color: '#666', fontWeight: 'bold' },
  clearBtn: { backgroundColor: '#FF3B30', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  clearBtnText: { color: 'white', fontSize: 12, fontWeight: 'bold' },
  controlBox: { backgroundColor: 'white', padding: 15, borderRadius: 15, marginBottom: 15, elevation: 2, shadowColor:'#000', shadowOpacity:0.1, shadowRadius:4 },
  sliderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  label: { fontSize: 16, fontWeight: 'bold' },
  unitBtn: { backgroundColor: '#E5E5EA', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5 },
  unitText: { fontSize: 10, fontWeight: 'bold', color: '#007AFF' },
  bigAddBtn: { backgroundColor: '#007AFF', padding: 12, borderRadius: 10, alignItems: 'center', marginTop: 5 },
  bigAddBtnText: { color: 'white', fontWeight: 'bold' },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', padding: 15, borderRadius: 12, marginBottom: 10, shadowColor:'#000', shadowOpacity:0.05, shadowRadius:2 },
  cardInactive: { opacity: 0.6, backgroundColor: '#E5E5EA' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardSub: { fontSize: 12, color: '#888' },
  cardActions: { flexDirection: 'row', gap: 10, alignItems: 'center' }
});