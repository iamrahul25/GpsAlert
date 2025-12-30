import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, FlatList, Alert, Switch, Platform, TextInput, Vibration, AppState, LogBox, Keyboard, KeyboardAvoidingView, Dimensions, ScrollView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import MapView, { Circle, Marker, Callout } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import { Audio } from 'expo-av';

// --- IGNORE ANNOYING "KEEP AWAKE" ERROR ---
LogBox.ignoreLogs([
  'Unable to activate keep awake',
  /Unable to activate keep awake/,
  'Error: Unable to activate keep awake'
]);

// --- CONSTANTS ---
const LOCATION_TASK_NAME = 'background-location-task';
const STORAGE_KEY = '@gps_alarms';
// CHANGED: New ID to force Android to reset sound settings for this channel
const CHANNEL_ID = 'alarm-channel-v2'; 

// --- GLOBAL SOUND OBJECT ---
let soundObject = new Audio.Sound();

// --- NOTIFICATION HANDLER ---
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // Suppress sound for refresh notifications (isRefresh flag in data)
    const isRefresh = notification.request.content.data?.isRefresh === true;
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: !isRefresh, // Don't play sound on refresh notifications
      shouldSetBadge: false,
    };
  },
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
    // Sound is not loaded, already unloaded, or in invalid state - this is fine, just ignore
    // Suppress common expected errors
    const errorMsg = e?.message || String(e) || '';
    if (!errorMsg.includes('not loaded') && 
        !errorMsg.includes('Cannot complete operation') &&
        !errorMsg.includes('Sound is not loaded')) {
      // Only log unexpected errors
      console.log("Stop Sound Error", e);
    }
  }
};

// --- HELPER: Show persistent alarm notification ---
const showAlarmNotification = async (alarm, silent = false) => {
  // Use scheduleNotificationAsync with trigger: null to show immediately
  await Notifications.scheduleNotificationAsync({
    identifier: `alarm-${alarm.id}`, // Unique ID per alarm
    content: {
      title: "🚨 ARRIVAL ALERT!",
      body: `Arrived at ${alarm.name}. Tap "Stop Alarm" to dismiss.`,
      categoryIdentifier: 'alarm-actions',
      data: { alarmId: alarm.id, isRefresh: silent }, // Track if this is a refresh
      priority: Notifications.AndroidNotificationPriority.MAX, 
      channelId: CHANNEL_ID,
      autoDismiss: false,
      sticky: true,
      // Only add sound/vibration on initial notification, not on refresh
      ...(silent ? {} : {
        vibrate: [0, 500, 1000, 500, 1000, 500], // Vibration pattern
      }),
    },
    trigger: null, // null trigger shows notification immediately
  });
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

      const dist = getDistance(
        currentLoc.latitude, currentLoc.longitude,
        alarm.latitude, alarm.longitude
      );

      if (dist <= alarm.radius) {
        // --- TRIGGER ALARM ---
        // 1. Play Continuous Audio
        playAlarmSound();

        // 2. Show Notification (with unique ID per alarm to prevent replacement)
        showAlarmNotification(alarm);
        
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
  const [selectedLocationName, setSelectedLocationName] = useState(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [mapRegion, setMapRegion] = useState(null);
  const [hasSetInitialRegion, setHasSetInitialRegion] = useState(false);
  const [selectedAlarmId, setSelectedAlarmId] = useState(null);
  const [sortByDistance, setSortByDistance] = useState(false);
  
  const mapRef = useRef(null);
  const flatListRef = useRef(null);
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

      if (actionId === 'stop') {
        stopAlarmAndRefresh(alarmId);
      }
      // If tapped notification body, sound is already stopped above
    });

    // Re-show notifications for active triggered alarms (prevents dismissal)
    // This makes notifications effectively non-dismissible until "Stop Alarm" is clicked
    // Using silent=true to prevent notification sound from playing on refresh
    const notificationRefreshInterval = setInterval(async () => {
      try {
        const json = await AsyncStorage.getItem(STORAGE_KEY);
        if (!json) return;
        const savedAlarms = JSON.parse(json);
        const triggeredAlarms = savedAlarms.filter(a => a.active && a.triggered);
        
        // Re-show notification silently for each active triggered alarm
        // Using same identifier will update existing notification or recreate if dismissed
        // silent=true prevents sound/vibration from playing on refresh
        for (const alarm of triggeredAlarms) {
          await showAlarmNotification(alarm, true); // true = silent refresh
        }
      } catch (e) {
        // Silently handle errors
      }
    }, 5000); // Check every 5 seconds (reduced frequency to minimize interruptions)

    return () => {
      if (responseListener.current) responseListener.current.remove();
      if (locationWatcher.current) locationWatcher.current.remove();
      clearInterval(gpsInterval);
      clearInterval(notificationRefreshInterval);
    };
  }, []);

  // Keyboard event listeners
  useEffect(() => {
    const keyboardWillShowListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
        setIsKeyboardVisible(true);
      }
    );
    const keyboardWillHideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
        setIsKeyboardVisible(false);
      }
    );

    return () => {
      keyboardWillShowListener.remove();
      keyboardWillHideListener.remove();
    };
  }, []);

  // --- ALARM ACTIONS ---
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
        
        // Dismiss the notification when alarm is stopped
        await Notifications.dismissNotificationAsync(`alarm-${id}`);
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
          // Set initial map region only once when location is first available
          if (!hasSetInitialRegion && loc) {
            setMapRegion({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              latitudeDelta: 0.05,
              longitudeDelta: 0.05,
            });
            setHasSetInitialRegion(true);
          }
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
      { identifier: 'stop', buttonTitle: '✅ Stop Alarm', options: { isDestructive: true, opensAppToForeground: true } },
    ]);
  };

  const loadAlarms = async () => {
    try {
      const json = await AsyncStorage.getItem(STORAGE_KEY);
      if (json) setAlarms(JSON.parse(json));
    } catch (e) {}
  };

  // --- REVERSE GEOCODING: Get location name from coordinates ---
  const getLocationName = async (latitude, longitude) => {
    try {
      const reverseGeocode = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });
      
      if (reverseGeocode && reverseGeocode.length > 0) {
        const address = reverseGeocode[0];
        const parts = [];
        
        // Add place name (name, street, or subThoroughfare)
        if (address.name) {
          parts.push(address.name);
        } else if (address.street) {
          parts.push(address.street);
        } else if (address.subThoroughfare) {
          parts.push(address.subThoroughfare);
        }
        
        // Add city
        if (address.city) {
          parts.push(address.city);
        } else if (address.subAdministrativeArea) {
          parts.push(address.subAdministrativeArea);
        }
        
        // Add state
        if (address.region) {
          parts.push(address.region);
        } else if (address.administrativeArea) {
          parts.push(address.administrativeArea);
        }
        
        // Add postal code (pin)
        if (address.postalCode) {
          parts.push(address.postalCode);
        }
        
        // Format as "Place name, city, state, pin"
        return parts.join(', ');
      }
      
      return null;
    } catch (error) {
      console.log("Reverse geocoding error:", error);
      return null;
    }
  };

  // --- UI ACTIONS ---
  const startCreating = () => {
    if (!selectedCoord) return Alert.alert("Tap Map", "Please tap a destination on the map first.");
    setEditingId(null);
    // Use location name if available, otherwise fallback to default
    setTempName(selectedLocationName || `Alarm #${alarms.length + 1}`);
    setTempRadius(500);
    setIsEditing(true);
  };

  const startEditing = async (alarm) => {
    setEditingId(alarm.id);
    setTempName(alarm.name);
    setTempRadius(alarm.radius);
    const coord = { latitude: alarm.latitude, longitude: alarm.longitude };
    setSelectedCoord(coord);
    setSelectedAlarmId(null); // Clear selection when editing
    // Get location name for the alarm location
    const locationName = await getLocationName(coord.latitude, coord.longitude);
    setSelectedLocationName(locationName);
    setIsEditing(true);
  };

  const saveAlarm = async () => {
    Keyboard.dismiss();
    // Reset keyboard state immediately
    setKeyboardHeight(0);
    setIsKeyboardVisible(false);
    
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
        triggered: false
      };
      newAlarmsList = [...alarms, newAlarm];
    }
    
    setAlarms(newAlarmsList);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newAlarmsList));
    setIsEditing(false);
    setSelectedCoord(null);
    setSelectedLocationName(null);

    if (location) {
      const changed = await checkAlarms(location.coords);
      if (changed) loadAlarms();
    }
  };

  const cancelEdit = () => {
    Keyboard.dismiss();
    // Reset keyboard state immediately
    setKeyboardHeight(0);
    setIsKeyboardVisible(false);
    setIsEditing(false);
    setSelectedCoord(null);
    setSelectedLocationName(null);
    setSelectedAlarmId(null);
  };

  const deleteAlarm = async (id) => {
    const updated = alarms.filter(a => a.id !== id);
    setAlarms(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const toggleAlarm = async (id) => {
    // Check if the alarm being toggled is currently ringing
    const alarmToToggle = alarms.find(a => a.id === id);
    const wasRinging = alarmToToggle && alarmToToggle.triggered && alarmToToggle.active;
    
    const updated = alarms.map(a => 
      a.id === id ? { ...a, active: !a.active, triggered: false } : a 
    );
    setAlarms(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    
    // If the alarm was ringing and is now being turned off
    if (wasRinging && !updated.find(a => a.id === id)?.active) {
      // Dismiss the notification for this specific alarm
      await Notifications.dismissNotificationAsync(`alarm-${id}`);
      
      // Check if there are any other alarms still ringing
      const otherRingingAlarms = updated.filter(a => a.active && a.triggered);
      
      // If no other alarms are ringing, stop the sound
      if (otherRingingAlarms.length === 0) {
        stopAlarmSound();
      }
    }
    
    if (location) {
        const changed = await checkAlarms(location.coords);
        if (changed) loadAlarms();
    }
  };

  // Get sorted alarms based on distance toggle
  const getSortedAlarms = () => {
    if (!sortByDistance || !location) {
      return alarms;
    }
    
    // Sort by distance from current position (least to most)
    return [...alarms].sort((a, b) => {
      const distA = getDistance(location.coords.latitude, location.coords.longitude, a.latitude, a.longitude);
      const distB = getDistance(location.coords.latitude, location.coords.longitude, b.latitude, b.longitude);
      return distA - distB;
    });
  };

  const renderItem = ({ item }) => {
    let distToEdge = 0;
    if (location) {
      const distToCenter = getDistance(location.coords.latitude, location.coords.longitude, item.latitude, item.longitude);
      distToEdge = Math.max(0, distToCenter - item.radius);
    }
    const distDisplay = distToEdge > 1000 ? `${(distToEdge / 1000).toFixed(1)} km` : `${distToEdge.toFixed(0)} m`;
    const isSelected = selectedAlarmId === item.id;

    return (
      <View style={[
        styles.card, 
        (!item.active || item.triggered) && styles.cardInactive,
        isSelected && styles.cardSelected
      ]}>
        <View style={{flex: 1}}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          {item.triggered && <Text style={{color:'red', fontWeight:'bold', marginTop: 4}}>RINGING!</Text>}
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

  // Handle alarm marker click
  const handleAlarmMarkerPress = (alarm) => {
    setSelectedAlarmId(alarm.id);
    setSelectedCoord(null); // Clear new pin selection
    
    // Scroll to the alarm in the list (use sorted list if sorting is enabled)
    if (flatListRef.current) {
      const sortedAlarms = getSortedAlarms();
      const alarmIndex = sortedAlarms.findIndex(a => a.id === alarm.id);
      if (alarmIndex !== -1) {
        setTimeout(() => {
          flatListRef.current?.scrollToIndex({ 
            index: alarmIndex, 
            animated: true,
            viewPosition: 0.5 // Center the item
          });
        }, 100);
      }
    }
  };

  // Fixed panel height - same for both edit and list views
  const PANEL_HEIGHT = "50%"; // Fixed height for the panel
  
  // Calculate map container flex - shrink when keyboard is visible to make room for panel above keyboard
  const mapContainerFlex = isKeyboardVisible && isEditing 
    ? 0.5  // Smaller flex when keyboard is visible
    : 1;   // Full flex when keyboard is hidden

  const content = (
    <>
      <StatusBar style="dark" />
      {!gpsEnabled && (
        <View style={styles.warningBar}><Text style={styles.warningText}>⚠️ GPS is Disabled! Alarms won't work.</Text></View>
      )}

      <View style={styles.statsHeader}>
        <View>
            <Text style={styles.statsLabel}>LAT: {location?.coords.latitude.toFixed(7) || "..."}</Text>
            <Text style={styles.statsLabel}>LNG: {location?.coords.longitude.toFixed(7) || "..."}</Text>
        </View>
        <View>
            <Text style={styles.statsLabel}>GPS Accuracy</Text>
            <Text style={[styles.statsValue, {color: (location?.coords.accuracy || 100) < 20 ? 'green' : 'orange'}]}>
                {location?.coords.accuracy?.toFixed(1) || "?"} m
            </Text>
        </View>
      </View>

      <View style={[styles.mapContainer, { flex: mapContainerFlex }]}>
        <MapView
            ref={mapRef}
            style={styles.map}
            showsUserLocation={true}
            showsMyLocationButton={true}
            onPress={async (e) => {
              if (!isEditing) {
                // Clear selected alarm when tapping on map
                setSelectedAlarmId(null);
                const coord = e.nativeEvent.coordinate;
                setSelectedCoord(coord);
                // Get location name when pin is dropped
                const locationName = await getLocationName(coord.latitude, coord.longitude);
                setSelectedLocationName(locationName);
              }
            }}
            region={mapRegion || {
              latitude: location ? location.coords.latitude : 28.6139,
              longitude: location ? location.coords.longitude : 77.2090,
              latitudeDelta: 0.05,
              longitudeDelta: 0.05,
            }}
            onRegionChangeComplete={(region) => {
              // Update map region when user manually moves/zooms the map
              setMapRegion(region);
            }}
        >
            {alarms.map((alarm) => (
            <React.Fragment key={alarm.id}>
                <Marker 
                  coordinate={alarm} 
                  pinColor={alarm.active ? "green" : "gray"}
                  onPress={() => handleAlarmMarkerPress(alarm)}
                >
                  <Callout>
                    <View style={styles.calloutContainer}>
                      <Text style={styles.calloutTitle}>{alarm.name}</Text>
                      <Text style={styles.calloutSubtext}>
                        Radius: {alarm.radius.toFixed(0)}m • {alarm.active ? "Active" : "Off"}
                      </Text>
                    </View>
                  </Callout>
                </Marker>
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
      </View>

      <View style={[
        styles.panel,
        { 
          height: PANEL_HEIGHT
        }
      ]}>
        {isEditing ? (
            <ScrollView 
              style={styles.editScrollView}
              contentContainerStyle={styles.editContainer}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={true}
            >
                <Text style={styles.panelTitle}>{editingId ? "Edit Alarm" : "New Alarm"}</Text>
                <TextInput 
                  style={styles.input} 
                  value={tempName} 
                  onChangeText={setTempName} 
                  placeholder="Alarm Name"
                  returnKeyType="done"
                  blurOnSubmit={true}
                />
                <View style={styles.sliderContainer}>
                    <Text style={styles.label}>Radius: {tempRadius.toFixed(0)} m</Text>
                    <Slider style={{width: '100%', height: 40}} minimumValue={50} maximumValue={5000} step={50} value={tempRadius} onValueChange={setTempRadius} minimumTrackTintColor="#FF9500" thumbTintColor="#FF9500" />
                </View>
                <View style={styles.buttonRow}>
                    <TouchableOpacity onPress={cancelEdit} style={[styles.actionBtn, {backgroundColor:'#ccc'}]}><Text style={styles.btnText}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity onPress={saveAlarm} style={[styles.actionBtn, {backgroundColor:'#007AFF'}]}><Text style={[styles.btnText, {color:'white'}]}>Save Alarm</Text></TouchableOpacity>
                </View>
            </ScrollView>
        ) : (
            <>
                <View style={styles.listHeader}>
                    <Text style={styles.panelTitle}>Your Alarms</Text>
                    <View style={{alignItems: 'flex-end'}}>
                        {selectedCoord ? (
                            <TouchableOpacity style={styles.createBtn} onPress={startCreating}><Text style={styles.createBtnText}>+ Set Alarm</Text></TouchableOpacity>
                        ) : (
                            <Text style={{color:'#888', fontSize:12}}>Tap map to create</Text>
                        )}
                        <View style={styles.sortToggleContainer}>
                            <Text style={styles.sortToggleLabel}>Sort by distance</Text>
                            <Switch 
                                value={sortByDistance} 
                                onValueChange={setSortByDistance}
                                trackColor={{ false: '#767577', true: '#007AFF' }}
                                thumbColor={sortByDistance ? '#fff' : '#f4f3f4'}
                            />
                        </View>
                    </View>
                </View>
                <FlatList 
                  ref={flatListRef}
                  data={getSortedAlarms()} 
                  keyExtractor={(item) => item.id} 
                  renderItem={renderItem} 
                  contentContainerStyle={{paddingBottom: 20}}
                  keyboardShouldPersistTaps="handled"
                  onScrollToIndexFailed={(info) => {
                    // Handle scroll failure gracefully
                    const wait = new Promise(resolve => setTimeout(resolve, 500));
                    wait.then(() => {
                      flatListRef.current?.scrollToIndex({ index: info.index, animated: true });
                    });
                  }}
                />
            </>
        )}
      </View>
    </>
  );

  return (
    isEditing ? (
      <KeyboardAvoidingView 
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {content}
      </KeyboardAvoidingView>
    ) : (
      <View style={styles.container}>
        {content}
      </View>
    )
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  warningBar: { backgroundColor: '#FF3B30', padding: 10, paddingTop: 50, alignItems: 'center', zIndex: 20 },
  warningText: { color: 'white', fontWeight: 'bold' },
  statsHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingTop: 40, paddingBottom: 3, backgroundColor: 'white', borderBottomWidth:1, borderBottomColor:'#ddd', zIndex: 10 },
  statsLabel: { fontSize: 10, color: '#666', fontWeight:'bold' },
  statsValue: { fontSize: 14, fontWeight: 'bold' },
  mapContainer: { flex: 1, position: 'relative', minHeight: 200 },
  map: { width: '100%', height: '100%' },
  fab: { position: 'absolute', bottom: 20, right: 20, backgroundColor: 'white', width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center', elevation: 5, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: {width:0, height:2} },
  panel: { 
    backgroundColor: 'white', 
    borderTopLeftRadius: 20, 
    borderTopRightRadius: 20, 
    padding: 20, 
    shadowColor:'#000', 
    shadowOpacity:0.1, 
    shadowRadius:10, 
    elevation:10,
    width: '100%'
  },
  panelTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sortToggleContainer: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  sortToggleLabel: { fontSize: 12, color: '#666', fontWeight: '500' },
  createBtn: { backgroundColor: '#007AFF', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 },
  createBtnText: { color: 'white', fontWeight: 'bold' },
  card: { backgroundColor: '#fff', borderWidth:1, borderColor:'#eee', padding: 15, borderRadius: 12, marginBottom: 10, flexDirection: 'row', justifyContent:'space-between' },
  cardInactive: { opacity: 0.6, backgroundColor: '#f9f9f9' },
  cardSelected: { borderWidth: 2, borderColor: '#007AFF', backgroundColor: '#E3F2FD' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardSub: { fontSize: 12, color: '#888', marginTop: 2 },
  cardActions: { alignItems: 'flex-end', justifyContent: 'space-between' },
  iconBtn: { padding: 5 },
  liveContainer: { marginTop: 8, backgroundColor: '#E3F2FD', padding: 4, borderRadius: 4, alignSelf: 'flex-start' },
  liveText: { color: '#007AFF', fontSize: 11, fontWeight: 'bold' },
  editScrollView: { flex: 1 },
  editContainer: { flexGrow: 1, justifyContent: 'flex-start', paddingBottom: 0 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 16, backgroundColor: '#F9F9F9', marginBottom: 15 },
  sliderContainer: { marginBottom: 15 },
  label: { fontSize: 14, fontWeight: 'bold', marginBottom: 5, color:'#555' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 0, marginBottom: 0 },
  actionBtn: { flex: 1, paddingVertical: 10, paddingHorizontal: 15, borderRadius: 10, alignItems: 'center' },
  btnText: { fontWeight: 'bold' },
  calloutContainer: { padding: 5, minWidth: 150 },
  calloutTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  calloutSubtext: { fontSize: 12, color: '#666' }
});