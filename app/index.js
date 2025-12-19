import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Alert, Switch, Platform, TextInput, Vibration, AppState } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';

// --- CONSTANTS ---
const LOCATION_TASK_NAME = 'background-location-task';
const STORAGE_KEY = '@gps_alarms';
const CHANNEL_ID = 'alarm-channel-id'; 

// --- NOTIFICATION HANDLER ---
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
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

// --- LOGIC: CHECK & TRIGGER ALARMS ---
const checkAlarms = async (currentLoc) => {
  try {
    const jsonValue = await AsyncStorage.getItem(STORAGE_KEY);
    const savedAlarms = jsonValue != null ? JSON.parse(jsonValue) : [];
    let alarmsUpdated = false;
    const now = Date.now();

    const updatedAlarms = savedAlarms.map(alarm => {
      if (!alarm.active || alarm.triggered) return alarm;
      if (alarm.snoozedUntil && now < alarm.snoozedUntil) return alarm;

      const dist = getDistance(
        currentLoc.latitude, currentLoc.longitude,
        alarm.latitude, alarm.longitude
      );

      if (dist <= alarm.radius) {
        // --- TRIGGER NOTIFICATION ---
        Notifications.scheduleNotificationAsync({
          content: {
            title: "🚨 WAKE UP! ARRIVAL ALERT!",
            body: `You have reached ${alarm.name}`,
            sound: 'default',
            categoryIdentifier: 'alarm-actions',
            data: { alarmId: alarm.id },
            priority: Notifications.AndroidNotificationPriority.MAX, 
            channelId: CHANNEL_ID,
            vibrate: [0, 1000, 500, 1000, 500, 1000],
            autoDismiss: false,
            sticky: true,
          },
          trigger: null,
        });
        
        alarmsUpdated = true;
        return { ...alarm, triggered: true, active: false };
      }
      return alarm;
    });

    if (alarmsUpdated) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updatedAlarms));
      return true; 
    }
  } catch (e) {
    // Silently fail to avoid crashing on rapid updates
  }
  return false;
};

// --- BACKGROUND TASK ---
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    // If background task fails (e.g. GPS off), usually we can't do much, 
    // but we suppress the error to prevent crash.
    return;
  }
  if (data) {
    const { locations } = data;
    await checkAlarms(locations[0].coords);
  }
});

// --- MAIN APP ---
export default function App() {
  const [location, setLocation] = useState(null);
  const [alarms, setAlarms] = useState([]);
  const [gpsEnabled, setGpsEnabled] = useState(true);
  
  // Editing State
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [tempName, setTempName] = useState("");
  const [tempRadius, setTempRadius] = useState(500);
  const [selectedCoord, setSelectedCoord] = useState(null);
  
  const mapRef = useRef(null);
  const responseListener = useRef();
  const locationWatcher = useRef(null);

  // --- INIT ---
  useEffect(() => {
    loadAlarms();
    requestPermissions();
    setupNotifications();
    startGpsStatusCheck();

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const actionId = response.actionIdentifier;
      const alarmId = response.notification.request.content.data.alarmId;
      if (actionId === 'snooze') snoozeAlarm(alarmId);
      if (actionId === 'stop') loadAlarms(); 
    });

    return () => {
      if (responseListener.current) responseListener.current.remove();
      if (locationWatcher.current) locationWatcher.current.remove();
    };
  }, []);

  // --- GPS STATUS MONITOR ---
  const startGpsStatusCheck = () => {
    // Check periodically
    const interval = setInterval(async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        
        // If status changed from ON to OFF, notify user
        if (gpsEnabled && !enabled) {
           Notifications.scheduleNotificationAsync({
            content: {
              title: "⚠️ GPS Disabled",
              body: "Alarms will not work until you turn location back on.",
              priority: Notifications.AndroidNotificationPriority.HIGH,
            },
            trigger: null,
          });
        }
        setGpsEnabled(enabled);
      } catch (e) {
        // Ignore service check errors
      }
    }, 3000);
    return () => clearInterval(interval);
  };

  // --- PERMISSIONS & SETUP ---
  const requestPermissions = async () => {
    try {
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (fgStatus !== 'granted') return Alert.alert("Error", "Location permission required.");
      
      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') Alert.alert("Warning", "Background location disabled.");

      const { status: notifStatus } = await Notifications.requestPermissionsAsync();
      if (notifStatus !== 'granted') Alert.alert("Error", "Notification permission required.");

      // CRASH FIX: Wrap startLocationUpdatesAsync safely
      try {
        const hasStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        if (!hasStarted) {
          await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 5000,
            distanceInterval: 5,
            showsBackgroundLocationIndicator: true,
            foregroundService: { notificationTitle: "GPS Alarm Active", notificationBody: "Checking location..." }
          });
        }
      } catch (err) {
        // Suppress "keep awake" error
      }

      // Foreground Watcher
      locationWatcher.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
        async (loc) => {
          setLocation(loc);
          setGpsEnabled(true); 
          const changed = await checkAlarms(loc.coords);
          if (changed) loadAlarms();
        }
      );
    } catch (e) {
      console.log("Setup Error:", e);
    }
  };

  const setupNotifications = async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Alarm Channel',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        sound: 'default',
        enableVibrate: true,
      });
    }
    await Notifications.setNotificationCategoryAsync('alarm-actions', [
      { identifier: 'snooze', buttonTitle: '💤 Snooze 5m', options: { opensAppToForeground: false } },
      { identifier: 'stop', buttonTitle: '✅ Stop Alarm', options: { isDestructive: true, opensAppToForeground: true } },
    ]);
  };

  const loadAlarms = async () => {
    try {
      const json = await AsyncStorage.getItem(STORAGE_KEY);
      if (json) setAlarms(JSON.parse(json));
    } catch (e) {}
  };

  // --- ACTIONS ---
  const recenterMap = () => {
    if (location && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      });
    }
  };

  const startCreating = () => {
    if (!selectedCoord) return Alert.alert("Tap Map", "Please tap a destination on the map first.");
    setEditingId(null);
    setTempName(`Alarm #${alarms.length + 1}`);
    setTempRadius(500);
    setIsEditing(true);
  };

  const startEditing = (alarm) => {
    setEditingId(alarm.id);
    setTempName(alarm.name);
    setTempRadius(alarm.radius);
    setSelectedCoord({ latitude: alarm.latitude, longitude: alarm.longitude });
    setIsEditing(true);
  };

  const saveAlarm = async () => {
    let newAlarmsList;
    if (editingId) {
      newAlarmsList = alarms.map(a => a.id === editingId ? { ...a, name: tempName, radius: tempRadius, active: true, triggered: false } : a);
    } else {
      const newAlarm = {
        id: Date.now().toString(),
        name: tempName,
        latitude: selectedCoord.latitude,
        longitude: selectedCoord.longitude,
        radius: tempRadius,
        active: true,
        triggered: false,
        snoozedUntil: 0
      };
      newAlarmsList = [...alarms, newAlarm];
    }
    
    setAlarms(newAlarmsList);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newAlarmsList));
    setIsEditing(false);
    setSelectedCoord(null);

    if (location) {
      const changed = await checkAlarms(location.coords);
      if (changed) loadAlarms();
    }
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setSelectedCoord(null);
  };

  const snoozeAlarm = async (id) => {
    const updated = alarms.map(a => a.id === id ? { ...a, triggered: false, active: true, snoozedUntil: Date.now() + 300000 } : a);
    setAlarms(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const deleteAlarm = async (id) => {
    const updated = alarms.filter(a => a.id !== id);
    setAlarms(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const toggleAlarm = async (id) => {
    const updated = alarms.map(a => 
      a.id === id ? { ...a, active: !a.active, triggered: false } : a 
    );
    setAlarms(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    
    if (location) {
        const changed = await checkAlarms(location.coords);
        if (changed) loadAlarms();
    }
  };

  const renderItem = ({ item }) => {
    let distToEdge = 0;
    if (location) {
      const distToCenter = getDistance(location.coords.latitude, location.coords.longitude, item.latitude, item.longitude);
      distToEdge = Math.max(0, distToCenter - item.radius);
    }
    const distDisplay = distToEdge > 1000 ? `${(distToEdge / 1000).toFixed(1)} km` : `${distToEdge.toFixed(0)} m`;

    return (
      <View style={[styles.card, (!item.active || item.triggered) && styles.cardInactive]}>
        <View style={{flex: 1}}>
          <View style={{flexDirection:'row', justifyContent:'space-between', alignItems:'center'}}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            {item.triggered && <Text style={{color:'red', fontWeight:'bold'}}>ARRIVED!</Text>}
          </View>
          <Text style={styles.cardSub}>Radius: {item.radius.toFixed(0)}m • {item.active ? "Active" : "Off"}</Text>
          {item.active && !item.triggered && (
            <View style={styles.liveContainer}><Text style={styles.liveText}>📍 {distDisplay} to boundary</Text></View>
          )}
        </View>
        <View style={styles.cardActions}>
          <TouchableOpacity onPress={() => startEditing(item)} style={styles.iconBtn}><Text style={{fontSize:18}}>✏️</Text></TouchableOpacity>
          <Switch value={item.active} onValueChange={() => toggleAlarm(item.id)} />
          <TouchableOpacity onPress={() => deleteAlarm(item.id)} style={styles.iconBtn}><Text style={{fontSize:18}}>🗑️</Text></TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* GPS OFF WARNING */}
      {!gpsEnabled && (
        <View style={styles.warningBar}>
          <Text style={styles.warningText}>⚠️ GPS is Disabled! Alarms won't work.</Text>
        </View>
      )}

      {/* HEADER STATS */}
      <View style={styles.statsHeader}>
        <View>
            <Text style={styles.statsLabel}>LAT: {location?.coords.latitude.toFixed(4) || "..."}</Text>
            <Text style={styles.statsLabel}>LNG: {location?.coords.longitude.toFixed(4) || "..."}</Text>
        </View>
        <View>
            <Text style={styles.statsLabel}>GPS Accuracy</Text>
            <Text style={[styles.statsValue, {color: (location?.coords.accuracy || 100) < 20 ? 'green' : 'orange'}]}>
                {location?.coords.accuracy?.toFixed(1) || "?"} m
            </Text>
        </View>
      </View>

      {/* MAP VIEW */}
      <View style={styles.mapContainer}>
        <MapView
            ref={mapRef}
            style={styles.map}
            showsUserLocation={true}
            onPress={(e) => !isEditing && setSelectedCoord(e.nativeEvent.coordinate)}
            initialRegion={{
            latitude: location ? location.coords.latitude : 28.6139,
            longitude: location ? location.coords.longitude : 77.2090,
            latitudeDelta: 0.05, longitudeDelta: 0.05,
            }}
        >
            {!isEditing && alarms.map((alarm) => (
            <React.Fragment key={alarm.id}>
                <Marker coordinate={alarm} pinColor={alarm.active ? "green" : "gray"} />
                <Circle center={alarm} radius={alarm.radius} fillColor={alarm.active ? "rgba(0, 255, 0, 0.1)" : "rgba(100,100,100,0.1)"} strokeColor={alarm.active ? "green" : "gray"} />
            </React.Fragment>
            ))}

            {selectedCoord && !isEditing && <Marker coordinate={selectedCoord} pinColor="blue" />}

            {isEditing && selectedCoord && (
                <>
                    <Marker coordinate={selectedCoord} pinColor="orange" />
                    <Circle 
                        center={selectedCoord} 
                        radius={tempRadius} 
                        fillColor="rgba(255, 165, 0, 0.2)" 
                        strokeColor="orange" 
                        strokeWidth={2}
                    />
                </>
            )}
        </MapView>

        <TouchableOpacity style={styles.fab} onPress={recenterMap}>
            <Text style={{fontSize: 20}}>📍</Text>
        </TouchableOpacity>
      </View>

      {/* BOTTOM PANEL */}
      <View style={styles.panel}>
        {isEditing ? (
            <View style={styles.editContainer}>
                <Text style={styles.panelTitle}>{editingId ? "Edit Alarm" : "New Alarm"}</Text>
                <TextInput style={styles.input} value={tempName} onChangeText={setTempName} placeholder="Alarm Name" />
                <View style={styles.sliderContainer}>
                    <Text style={styles.label}>Radius: {tempRadius.toFixed(0)} m</Text>
                    <Slider 
                        style={{width: '100%', height: 40}} 
                        minimumValue={50} maximumValue={5000} step={50} 
                        value={tempRadius} onValueChange={setTempRadius} 
                        minimumTrackTintColor="#FF9500" thumbTintColor="#FF9500" 
                    />
                </View>
                <View style={styles.buttonRow}>
                    <TouchableOpacity onPress={cancelEdit} style={[styles.actionBtn, {backgroundColor:'#ccc'}]}>
                        <Text style={styles.btnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={saveAlarm} style={[styles.actionBtn, {backgroundColor:'#007AFF'}]}>
                        <Text style={[styles.btnText, {color:'white'}]}>Save Alarm</Text>
                    </TouchableOpacity>
                </View>
            </View>
        ) : (
            <>
                <View style={styles.listHeader}>
                    <Text style={styles.panelTitle}>Your Alarms</Text>
                    {selectedCoord ? (
                        <TouchableOpacity style={styles.createBtn} onPress={startCreating}>
                            <Text style={styles.createBtnText}>+ Set Alarm</Text>
                        </TouchableOpacity>
                    ) : (
                        <Text style={{color:'#888', fontSize:12}}>Tap map to create</Text>
                    )}
                </View>
                <FlatList 
                    data={alarms} 
                    keyExtractor={(item) => item.id} 
                    renderItem={renderItem} 
                    contentContainerStyle={{paddingBottom: 20}}
                />
            </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  warningBar: { backgroundColor: '#FF3B30', padding: 10, paddingTop: 40, alignItems: 'center', zIndex: 20 },
  warningText: { color: 'white', fontWeight: 'bold' },
  statsHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingTop: 10, paddingBottom: 10, backgroundColor: 'white', borderBottomWidth:1, borderBottomColor:'#ddd', zIndex: 10 },
  statsLabel: { fontSize: 10, color: '#666', fontWeight:'bold' },
  statsValue: { fontSize: 14, fontWeight: 'bold' },
  mapContainer: { flex: 1, position: 'relative' },
  map: { width: '100%', height: '100%' },
  fab: { position: 'absolute', bottom: 20, right: 20, backgroundColor: 'white', width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center', elevation: 5, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: {width:0, height:2} },
  panel: { height: '40%', backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, shadowColor:'#000', shadowOpacity:0.1, shadowRadius:10, elevation:10 },
  panelTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  createBtn: { backgroundColor: '#007AFF', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 },
  createBtnText: { color: 'white', fontWeight: 'bold' },
  card: { backgroundColor: '#fff', borderWidth:1, borderColor:'#eee', padding: 15, borderRadius: 12, marginBottom: 10, flexDirection: 'row', justifyContent:'space-between' },
  cardInactive: { opacity: 0.6, backgroundColor: '#f9f9f9' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardSub: { fontSize: 12, color: '#888', marginTop: 2 },
  cardActions: { alignItems: 'flex-end', justifyContent: 'space-between' },
  iconBtn: { padding: 5 },
  liveContainer: { marginTop: 8, backgroundColor: '#E3F2FD', padding: 4, borderRadius: 4, alignSelf: 'flex-start' },
  liveText: { color: '#007AFF', fontSize: 11, fontWeight: 'bold' },
  editContainer: { flex: 1, justifyContent: 'space-between' },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16, backgroundColor: '#F9F9F9', marginBottom: 15 },
  sliderContainer: { marginBottom: 15 },
  label: { fontSize: 14, fontWeight: 'bold', marginBottom: 5, color:'#555' },
  buttonRow: { flexDirection: 'row', gap: 10 },
  actionBtn: { flex: 1, padding: 15, borderRadius: 10, alignItems: 'center' },
  btnText: { fontWeight: 'bold' }
});