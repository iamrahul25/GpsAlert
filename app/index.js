import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Alert, Switch, Platform, Modal, TextInput } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';

// --- CONSTANTS ---
const LOCATION_TASK_NAME = 'background-location-task';
const STORAGE_KEY = '@gps_alarms';
const CHANNEL_ID = 'alarm-channel-id'; // Unique ID for the channel

// --- NOTIFICATION HANDLER ---
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

// --- LOGIC: CHECK & TRIGGER ALARMS ---
// We extract this so we can use it in Background AND Foreground (for instant testing)
const checkAlarms = async (currentLoc) => {
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
          title: "🚨 ARRIVAL ALERT!",
          body: `You have reached ${alarm.name}`,
          sound: 'default',
          categoryIdentifier: 'alarm-actions', // Shows buttons
          data: { alarmId: alarm.id },
          priority: Notifications.AndroidNotificationPriority.MAX, 
          channelId: CHANNEL_ID, // <--- CRITICAL FIX: Links to the high-priority channel
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
    return true; // Return true to signal UI refresh needed
  }
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
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [tempName, setTempName] = useState("");
  const [tempRadius, setTempRadius] = useState(500);
  const [selectedCoord, setSelectedCoord] = useState(null);
  
  const mapRef = useRef(null);
  const responseListener = useRef();

  // --- INITIALIZATION ---
  useEffect(() => {
    loadAlarms();
    requestPermissions();
    setupNotifications();

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const actionId = response.actionIdentifier;
      const alarmId = response.notification.request.content.data.alarmId;
      if (actionId === 'snooze') snoozeAlarm(alarmId);
      if (actionId === 'stop') loadAlarms(); 
    });

    return () => {
      if (responseListener.current) responseListener.current.remove();
    };
  }, []);

  // --- PERMISSIONS & SETUP ---
  const requestPermissions = async () => {
    // 1. Location
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') return Alert.alert("Error", "Location permission is required.");
    
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') Alert.alert("Warning", "Background location disabled.");

    // 2. Notifications (Android 13+ requires explicit permission)
    const { status: notifStatus } = await Notifications.requestPermissionsAsync();
    if (notifStatus !== 'granted') Alert.alert("Error", "Notification permission is required for alarms.");

    // 3. Start Background Service
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 5000,
      distanceInterval: 5,
      showsBackgroundLocationIndicator: true,
      foregroundService: { notificationTitle: "GPS Alarm", notificationBody: "Tracking..." }
    });

    // 4. Foreground Watcher (Updates UI & Checks triggers instantly)
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
      async (loc) => {
        setLocation(loc);
        // Optional: Check alarms in foreground too for instant feedback
        const changed = await checkAlarms(loc.coords);
        if (changed) loadAlarms();
      }
    );
  };

  const setupNotifications = async () => {
    if (Platform.OS === 'android') {
      // Create a specific channel for Alarms that overrides Do Not Disturb if possible
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'GPS Arrival Alarms',
        importance: Notifications.AndroidImportance.MAX, // Pops up on screen
        vibrationPattern: [0, 250, 250, 250],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC, // Visible on lock screen
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
    const json = await AsyncStorage.getItem(STORAGE_KEY);
    if (json) setAlarms(JSON.parse(json));
  };

  // --- ACTIONS ---
  const openAddModal = () => {
    if (!selectedCoord) return Alert.alert("Tap Map", "Tap a location first.");
    setEditingId(null);
    setTempName(`Alarm #${alarms.length + 1}`);
    setTempRadius(500);
    setModalVisible(true);
  };

  const openEditModal = (alarm) => {
    setEditingId(alarm.id);
    setTempName(alarm.name);
    setTempRadius(alarm.radius);
    setModalVisible(true);
  };

  const saveAlarm = async () => {
    let newAlarmsList;
    if (editingId) {
      newAlarmsList = alarms.map(a => a.id === editingId ? { ...a, name: tempName, radius: tempRadius } : a);
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
      setSelectedCoord(null);
    }
    
    setAlarms(newAlarmsList);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newAlarmsList));
    setModalVisible(false);

    // Instant Check: Did we place the pin on ourselves?
    if (location) {
      const changed = await checkAlarms(location.coords);
      if (changed) loadAlarms(); // Refresh if it triggered immediately
    }
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
    const updated = alarms.map(a => a.id === id ? { ...a, active: !a.active, triggered: false } : a);
    setAlarms(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
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
          <TouchableOpacity onPress={() => openEditModal(item)} style={styles.iconBtn}><Text style={{fontSize:18}}>✏️</Text></TouchableOpacity>
          <Switch value={item.active} onValueChange={() => toggleAlarm(item.id)} />
          <TouchableOpacity onPress={() => deleteAlarm(item.id)} style={styles.iconBtn}><Text style={{fontSize:18}}>🗑️</Text></TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        showsUserLocation={true}
        onPress={(e) => !modalVisible && setSelectedCoord(e.nativeEvent.coordinate)}
        initialRegion={{
          latitude: location ? location.coords.latitude : 28.6139,
          longitude: location ? location.coords.longitude : 77.2090,
          latitudeDelta: 0.05, longitudeDelta: 0.05,
        }}
      >
        {alarms.map((alarm) => (
          <React.Fragment key={alarm.id}>
            <Marker coordinate={alarm} pinColor={alarm.active ? "green" : "gray"} />
            <Circle center={alarm} radius={alarm.radius} fillColor={alarm.active ? "rgba(0, 255, 0, 0.1)" : "rgba(100,100,100,0.1)"} strokeColor={alarm.active ? "green" : "gray"} />
          </React.Fragment>
        ))}
        {selectedCoord && <Marker coordinate={selectedCoord} pinColor="blue" />}
      </MapView>

      <View style={styles.panel}>
        <View style={styles.header}>
           <Text style={styles.gpsText}>{location ? "GPS Active" : "Locating..."}</Text>
           {selectedCoord && (
             <TouchableOpacity style={styles.createBtn} onPress={openAddModal}>
               <Text style={styles.createBtnText}>+ Create Alarm</Text>
             </TouchableOpacity>
           )}
        </View>
        <FlatList data={alarms} keyExtractor={(item) => item.id} renderItem={renderItem} ListEmptyComponent={<Text style={{textAlign:'center', color:'#999', marginTop:20}}>Tap map to add an alarm</Text>} />
      </View>

      <Modal animationType="slide" transparent={true} visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{editingId ? "Edit Alarm" : "New Alarm"}</Text>
            <Text style={styles.inputLabel}>Name</Text>
            <TextInput style={styles.input} value={tempName} onChangeText={setTempName} placeholder="Alarm Name" />
            <Text style={styles.inputLabel}>Radius: {tempRadius.toFixed(0)}m</Text>
            <Slider style={{width: '100%', height: 40}} minimumValue={50} maximumValue={5000} step={50} value={tempRadius} onValueChange={setTempRadius} minimumTrackTintColor="#007AFF" thumbTintColor="#007AFF" />
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => setModalVisible(false)} style={[styles.modalBtn, {backgroundColor:'#ccc'}]}><Text style={{fontWeight:'bold'}}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={saveAlarm} style={[styles.modalBtn, {backgroundColor:'#007AFF'}]}><Text style={{color:'white', fontWeight:'bold'}}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  map: { width: '100%', height: '45%' },
  panel: { flex: 1, padding: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  gpsText: { fontSize: 12, color: '#666', fontWeight: 'bold' },
  createBtn: { backgroundColor: '#007AFF', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 },
  createBtnText: { color: 'white', fontWeight: 'bold' },
  card: { backgroundColor: 'white', padding: 15, borderRadius: 12, marginBottom: 10, shadowColor:'#000', shadowOpacity:0.05, shadowRadius:2, flexDirection: 'row', justifyContent:'space-between' },
  cardInactive: { opacity: 0.6, backgroundColor: '#E5E5EA' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardSub: { fontSize: 12, color: '#888', marginTop: 2 },
  cardActions: { alignItems: 'flex-end', justifyContent: 'space-between' },
  iconBtn: { padding: 5 },
  liveContainer: { marginTop: 8, backgroundColor: '#E3F2FD', padding: 6, borderRadius: 6, alignSelf: 'flex-start' },
  liveText: { color: '#007AFF', fontSize: 12, fontWeight: 'bold' },
  modalOverlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 20 },
  modalContent: { backgroundColor: 'white', borderRadius: 20, padding: 20, alignItems: 'stretch' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 15, textAlign: 'center' },
  inputLabel: { fontSize: 14, color: '#666', marginBottom: 5, marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 16, backgroundColor: '#F9F9F9' },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  modalBtn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', marginHorizontal: 5 },
});