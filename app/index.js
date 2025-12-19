import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Alert, Switch, Platform, TextInput, Vibration, AppState, LogBox } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import { Audio } from 'expo-av';

// --- IGNORE ANNOYING "KEEP AWAKE" ERROR ---
LogBox.ignoreLogs(['Unable to activate keep awake']);

// --- CONSTANTS ---
const LOCATION_TASK_NAME = 'background-location-task';
const STORAGE_KEY = '@gps_alarms';
// CHANGED: New ID to force Android to reset sound settings for this channel
const CHANNEL_ID = 'alarm-channel-v2'; 

// --- GLOBAL SOUND OBJECT ---
let soundObject = new Audio.Sound();

// --- NOTIFICATION HANDLER ---
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true, // Allow system notification sound as backup
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

// --- AUDIO: PLAY LOOPING ALARM ---
const playAlarmSound = async () => {
  try {
    // 1. Check if already playing
    const status = await soundObject.getStatusAsync();
    if (status.isLoaded && status.isPlaying) return; 

    // 2. Unload previous to be safe
    await soundObject.unloadAsync();
    
    // 3. Load and Play (Looping)
    // MAKE SURE 'alarm.mp3' IS IN YOUR ASSETS FOLDER!
    await soundObject.loadAsync(require('../assets/alarm.mp3')); 
    await soundObject.setIsLoopingAsync(true);
    await soundObject.playAsync();
    
  } catch (error) {
    console.log("Sound Error - Did you add alarm.mp3 to assets?", error);
  }
};

const stopAlarmSound = async () => {
  try {
    const status = await soundObject.getStatusAsync();
    if (status.isLoaded) {
        await soundObject.stopAsync();
        await soundObject.unloadAsync();
    }
  } catch (e) {
    console.log("Stop Sound Error", e);
  }
};

// --- LOGIC: CHECK & TRIGGER ALARMS ---
const checkAlarms = async (currentLoc) => {
  try {
    const jsonValue = await AsyncStorage.getItem(STORAGE_KEY);
    const savedAlarms = jsonValue != null ? JSON.parse(jsonValue) : [];
    let alarmsUpdated = false;
    const now = Date.now();

    const updatedAlarms = savedAlarms.map(alarm => {
      if (!alarm.active) return alarm; 
      if (alarm.triggered) return alarm; 
      if (alarm.snoozedUntil && now < alarm.snoozedUntil) return alarm;

      const dist = getDistance(
        currentLoc.latitude, currentLoc.longitude,
        alarm.latitude, alarm.longitude
      );

      if (dist <= alarm.radius) {
        // --- TRIGGER ALARM ---
        // 1. Play Continuous Audio
        playAlarmSound();

        // 2. Show Notification
        Notifications.scheduleNotificationAsync({
          content: {
            title: "🚨 ARRIVAL ALERT!",
            body: `Arrived at ${alarm.name}. Tap to Silence.`,
            categoryIdentifier: 'alarm-actions',
            data: { alarmId: alarm.id },
            priority: Notifications.AndroidNotificationPriority.MAX, 
            channelId: CHANNEL_ID,
            autoDismiss: false,
            sticky: true,
            vibrate: [0, 500, 1000, 500, 1000, 500], // Vibration pattern
          },
          trigger: null,
        });
        
        alarmsUpdated = true;
        // Mark triggered but keep 'active' true so it stays ON in UI until stopped
        return { ...alarm, triggered: true }; 
      }
      return alarm;
    });

    if (alarmsUpdated) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updatedAlarms));
      return true; 
    }
  } catch (e) { }
  return false;
};

// --- BACKGROUND TASK ---
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) return;
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
  
  const hasShownGpsWarning = useRef(false);
  
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
    // Enable Background Audio Mode
    Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
    });

    loadAlarms();
    requestPermissions();
    setupNotifications();
    const gpsInterval = startGpsStatusCheck();

    // NOTIFICATION LISTENER
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const actionId = response.actionIdentifier;
      const alarmId = response.notification.request.content.data.alarmId;
      
      // Stop the ringing immediately upon interaction
      stopAlarmSound(); 

      if (actionId === 'snooze') {
        snoozeAlarm(alarmId);
      } else if (actionId === 'stop') {
        stopAlarmAndRefresh(alarmId);
      } else {
        // Tapped notification body -> Stop sound, open app
        stopAlarmSound(); 
      }
    });

    return () => {
      if (responseListener.current) responseListener.current.remove();
      if (locationWatcher.current) locationWatcher.current.remove();
      clearInterval(gpsInterval);
    };
  }, []);

  // --- ALARM ACTIONS ---
  const snoozeAlarm = async (id) => {
    try {
        const json = await AsyncStorage.getItem(STORAGE_KEY);
        if (!json) return;
        
        let currentList = JSON.parse(json);
        const updated = currentList.map(a => a.id === id ? { ...a, triggered: false, active: true, snoozedUntil: Date.now() + 300000 } : a);
        
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        setAlarms(updated); 
        stopAlarmSound();
        Alert.alert("Snoozed", "Alarm paused for 5 minutes.");
    } catch (e) { console.log(e); }
  };

  const stopAlarmAndRefresh = async (id) => {
    try {
        const json = await AsyncStorage.getItem(STORAGE_KEY);
        if (!json) return;

        let currentList = JSON.parse(json);
        // Turn OFF the alarm completely
        const updated = currentList.map(a => a.id === id ? { ...a, triggered: false, active: false } : a);

        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        setAlarms(updated);
        stopAlarmSound();
    } catch(e) { console.log(e); }
  };

  // --- BACKGROUND & GPS MANAGEMENT ---
  const manageBackgroundService = async (shouldBeRunning) => {
    try {
      const hasStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (shouldBeRunning && !hasStarted) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 5,
          showsBackgroundLocationIndicator: true,
          foregroundService: { notificationTitle: "GPS Alarm Active", notificationBody: "Checking location..." }
        });
      } else if (!shouldBeRunning && hasStarted) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    } catch (e) { }
  };

  const startGpsStatusCheck = () => {
    return setInterval(async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        if (!enabled) {
          await manageBackgroundService(false);
          if (!hasShownGpsWarning.current) {
             Notifications.scheduleNotificationAsync({
              content: { title: "⚠️ GPS Disabled", body: "Alarms paused.", priority: Notifications.AndroidNotificationPriority.HIGH },
              trigger: null,
            });
            hasShownGpsWarning.current = true;
          }
        } else {
          await manageBackgroundService(true);
          hasShownGpsWarning.current = false;
        }
        setGpsEnabled(enabled);
      } catch (e) { }
    }, 3000);
  };

  const requestPermissions = async () => {
    try {
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (fgStatus !== 'granted') return Alert.alert("Error", "Location permission required.");
      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      const { status: notifStatus } = await Notifications.requestPermissionsAsync();
      
      await manageBackgroundService(true);

      locationWatcher.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
        async (loc) => {
          setLocation(loc);
          setGpsEnabled(true); 
          const changed = await checkAlarms(loc.coords);
          if (changed) loadAlarms();
        }
      );
    } catch (e) {}
  };

  const setupNotifications = async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Alarm Channel V2', // Changed name
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 200, 500],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        sound: 'default', // Fallback system sound
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

  // --- UI ACTIONS ---
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
            {item.triggered && <Text style={{color:'red', fontWeight:'bold'}}>RINGING!</Text>}
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
      {!gpsEnabled && (
        <View style={styles.warningBar}><Text style={styles.warningText}>⚠️ GPS is Disabled! Alarms won't work.</Text></View>
      )}

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
                    <Circle center={selectedCoord} radius={tempRadius} fillColor="rgba(255, 165, 0, 0.2)" strokeColor="orange" strokeWidth={2} />
                </>
            )}
        </MapView>
        <TouchableOpacity style={styles.fab} onPress={recenterMap}><Text style={{fontSize: 20}}>📍</Text></TouchableOpacity>
      </View>

      <View style={styles.panel}>
        {isEditing ? (
            <View style={styles.editContainer}>
                <Text style={styles.panelTitle}>{editingId ? "Edit Alarm" : "New Alarm"}</Text>
                <TextInput style={styles.input} value={tempName} onChangeText={setTempName} placeholder="Alarm Name" />
                <View style={styles.sliderContainer}>
                    <Text style={styles.label}>Radius: {tempRadius.toFixed(0)} m</Text>
                    <Slider style={{width: '100%', height: 40}} minimumValue={50} maximumValue={5000} step={50} value={tempRadius} onValueChange={setTempRadius} minimumTrackTintColor="#FF9500" thumbTintColor="#FF9500" />
                </View>
                <View style={styles.buttonRow}>
                    <TouchableOpacity onPress={cancelEdit} style={[styles.actionBtn, {backgroundColor:'#ccc'}]}><Text style={styles.btnText}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity onPress={saveAlarm} style={[styles.actionBtn, {backgroundColor:'#007AFF'}]}><Text style={[styles.btnText, {color:'white'}]}>Save Alarm</Text></TouchableOpacity>
                </View>
            </View>
        ) : (
            <>
                <View style={styles.listHeader}>
                    <Text style={styles.panelTitle}>Your Alarms</Text>
                    {selectedCoord ? (
                        <TouchableOpacity style={styles.createBtn} onPress={startCreating}><Text style={styles.createBtnText}>+ Set Alarm</Text></TouchableOpacity>
                    ) : (
                        <Text style={{color:'#888', fontSize:12}}>Tap map to create</Text>
                    )}
                </View>
                <FlatList data={alarms} keyExtractor={(item) => item.id} renderItem={renderItem} contentContainerStyle={{paddingBottom: 20}} />
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