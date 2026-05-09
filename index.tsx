import { registerRootComponent } from 'expo';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  DeviceEventEmitter,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

// ─── Constants ─────────────────────────────────────────────────────────────────

const LOCATION_TASK = 'background-location-task';
const GEOFENCE_TASK = 'geofence-task';
const LOCATION_UPDATE_EVENT = 'bmt_location_update';
const GEOFENCE_EVENT = 'bmt_geofence_event';
const DEFAULT_GOAL_KM = 1.0;

// Geofence: Bates Technical College, Tacoma, WA
const GEOFENCE_CENTER = { latitude: 47.2311, longitude: -122.4446 };
const GEOFENCE_RADIUS_M = 200;
const GEOFENCE_LABEL = 'Bates Technical College';

const MAP_HEIGHT = Dimensions.get('window').height * 0.4;

const INITIAL_MAP_REGION = {
  latitude: GEOFENCE_CENTER.latitude,
  longitude: GEOFENCE_CENTER.longitude,
  latitudeDelta: 0.008,
  longitudeDelta: 0.008,
};

// ─── Notification handler ──────────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ─── Types ─────────────────────────────────────────────────────────────────────

type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

type GeofenceStatus = 'unknown' | 'inside' | 'outside';

// ─── Module-level track log ────────────────────────────────────────────────────

const trackLog: Coordinate[] = [];

// ─── Background location task ──────────────────────────────────────────────────

TaskManager.defineTask(
  LOCATION_TASK,
  async ({
    data,
    error,
  }: {
    data: { locations: Location.LocationObject[] };
    error: TaskManager.TaskManagerError | null;
  }) => {
    if (error) return;
    for (const loc of data.locations) {
      const coord: Coordinate = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        timestamp: loc.timestamp,
      };
      trackLog.push(coord);
      DeviceEventEmitter.emit(LOCATION_UPDATE_EVENT, coord);
    }
  }
);

// ─── Geofence task ─────────────────────────────────────────────────────────────

TaskManager.defineTask(
  GEOFENCE_TASK,
  async ({
    data,
    error,
  }: {
    data: { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
    error: TaskManager.TaskManagerError | null;
  }) => {
    if (error) return;
    const { eventType } = data;
    if (eventType === Location.GeofencingEventType.Enter) {
      DeviceEventEmitter.emit(GEOFENCE_EVENT, { type: 'enter' });
    } else if (eventType === Location.GeofencingEventType.Exit) {
      DeviceEventEmitter.emit(GEOFENCE_EVENT, { type: 'exit' });
    }
  }
);

// ─── GPS task options ──────────────────────────────────────────────────────────

const BG_TASK_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.High,
  timeInterval: 1000,
  distanceInterval: 1,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'BuildMyTracks',
    notificationBody: 'Tracking your location in the background.',
    notificationColor: '#3b82f6',
  },
};

const FG_WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  timeInterval: 1000,
  distanceInterval: 1,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function sendNotification(title: string, body: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: null,
  });
}

// ─── Component ─────────────────────────────────────────────────────────────────

function App() {
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);
  const [logLength, setLogLength] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [totalDistanceKm, setTotalDistanceKm] = useState(0);
  const [goalKmInput, setGoalKmInput] = useState(String(DEFAULT_GOAL_KM));
  const [pathCoords, setPathCoords] = useState<Coordinate[]>([]);
  const [geofenceStatus, setGeofenceStatus] = useState<GeofenceStatus>('unknown');
  const [geofenceMessage, setGeofenceMessage] = useState<string | null>(null);

  const subscriberRef = useRef<Location.LocationSubscription | null>(null);
  const distanceRef = useRef(0);
  const goalReachedRef = useRef(false);
  const mapRef = useRef<MapView>(null);

  const goalKm = parseFloat(goalKmInput) || DEFAULT_GOAL_KM;

  // ── Notification permission ────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Notifications Disabled',
          'Enable notifications in your device settings to receive tracking alerts.',
          [{ text: 'OK' }]
        );
      }
    })();
  }, []);

  // ── Location event listener ────────────────────────────────────────────────

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      LOCATION_UPDATE_EVENT,
      (coord: Coordinate) => {
        setLatitude(coord.latitude);
        setLongitude(coord.longitude);
        setLogLength(trackLog.length);
        setPathCoords([...trackLog]);

        mapRef.current?.animateToRegion(
          {
            latitude: coord.latitude,
            longitude: coord.longitude,
            latitudeDelta: 0.005,
            longitudeDelta: 0.005,
          },
          800
        );

        if (trackLog.length >= 2) {
          const prev = trackLog[trackLog.length - 2];
          const curr = trackLog[trackLog.length - 1];
          const delta = haversineKm(
            prev.latitude,
            prev.longitude,
            curr.latitude,
            curr.longitude
          );
          distanceRef.current += delta;
          setTotalDistanceKm(distanceRef.current);

          if (!goalReachedRef.current && distanceRef.current >= goalKm) {
            goalReachedRef.current = true;
            sendNotification(
              'Goal Reached!',
              `Amazing work! You've traveled ${goalKm.toFixed(2)} km. Keep it up!`
            );
          }
        }
      }
    );
    return () => sub.remove();
  }, [goalKm]);

  // ── Geofence event listener ────────────────────────────────────────────────

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      GEOFENCE_EVENT,
      ({ type }: { type: 'enter' | 'exit' }) => {
        if (type === 'enter') {
          setGeofenceStatus('inside');
          setGeofenceMessage(`You entered ${GEOFENCE_LABEL}`);
          Alert.alert(
            'Geofence Entry',
            `You have entered the geofenced area around ${GEOFENCE_LABEL}.`,
            [{ text: 'OK' }]
          );
          sendNotification('Geofence Entry', `You entered ${GEOFENCE_LABEL}`);
        } else {
          setGeofenceStatus('outside');
          setGeofenceMessage(`You exited ${GEOFENCE_LABEL}`);
          Alert.alert(
            'Geofence Exit',
            `You have exited the geofenced area around ${GEOFENCE_LABEL}.`,
            [{ text: 'OK' }]
          );
          sendNotification('Geofence Exit', `You exited ${GEOFENCE_LABEL}`);
        }
      }
    );
    return () => sub.remove();
  }, []);

  // ── Restore tracking state after app restart ───────────────────────────────

  useEffect(() => {
    async function restoreTrackingState() {
      try {
        const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
        if (isRunning) {
          setTracking(true);
          setBackgroundMode(true);
          if (trackLog.length > 0) {
            const latest = trackLog[trackLog.length - 1];
            setLatitude(latest.latitude);
            setLongitude(latest.longitude);
            setLogLength(trackLog.length);
            setPathCoords([...trackLog]);
          }
        }
      } catch {
        // safe to ignore — app starts in idle state
      }
    }
    restoreTrackingState();
  }, []);

  // ── Sync on foreground return ──────────────────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && trackLog.length > 0) {
        const latest = trackLog[trackLog.length - 1];
        setLatitude(latest.latitude);
        setLongitude(latest.longitude);
        setLogLength(trackLog.length);
        setPathCoords([...trackLog]);
      }
    });
    return () => sub.remove();
  }, []);

  // ── GPS helpers ────────────────────────────────────────────────────────────

  async function attachForegroundSubscription() {
    const subscription = await Location.watchPositionAsync(
      FG_WATCH_OPTIONS,
      (loc) => {
        const coord: Coordinate = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          timestamp: loc.timestamp,
        };
        trackLog.push(coord);
        DeviceEventEmitter.emit(LOCATION_UPDATE_EVENT, coord);
      }
    );
    subscriberRef.current = subscription;
  }

  async function detachGps() {
    if (backgroundMode) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    } else {
      subscriberRef.current?.remove();
      subscriberRef.current = null;
    }
  }

  async function startGeofence() {
    try {
      await Location.startGeofencingAsync(GEOFENCE_TASK, [
        {
          identifier: GEOFENCE_LABEL,
          latitude: GEOFENCE_CENTER.latitude,
          longitude: GEOFENCE_CENTER.longitude,
          radius: GEOFENCE_RADIUS_M,
          notifyOnEnter: true,
          notifyOnExit: true,
        },
      ]);
    } catch {
      // Geofencing may not be available on all simulators
    }
  }

  async function stopGeofence() {
    try {
      const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
      if (running) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK);
      }
    } catch {
      // safe to ignore
    }
  }

  // ── Get single fix ─────────────────────────────────────────────────────────

  async function getLocation() {
    setLoading(true);
    setError(null);
    setLatitude(null);
    setLongitude(null);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission was denied. Please enable it in your device settings.');
        return;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      setLatitude(loc.coords.latitude);
      setLongitude(loc.coords.longitude);

      mapRef.current?.animateToRegion(
        {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        },
        800
      );
    } catch {
      setError('Unable to retrieve location. Please ensure GPS is enabled and try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Start tracking ─────────────────────────────────────────────────────────

  async function startTracking() {
    setError(null);
    setLoading(true);

    try {
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (fgStatus !== 'granted') {
        setError('Location permission was denied. Please enable it in your device settings.');
        return;
      }

      const isBackground = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Background Location',
          'BuildMyTracks needs "Allow all the time" location access to continue tracking your route when you switch apps or lock your device.\n\nWithout it, tracking will pause whenever the app is in the background.',
          [
            { text: 'Foreground Only', style: 'cancel', onPress: () => resolve(false) },
            {
              text: 'Allow Background',
              onPress: async () => {
                const { status: bgStatus } =
                  await Location.requestBackgroundPermissionsAsync();
                resolve(bgStatus === 'granted');
              },
            },
          ]
        );
      });

      // Reset session
      trackLog.length = 0;
      distanceRef.current = 0;
      goalReachedRef.current = false;
      setLogLength(0);
      setTotalDistanceKm(0);
      setPathCoords([]);
      setGeofenceStatus('unknown');
      setGeofenceMessage(null);

      if (isBackground) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, BG_TASK_OPTIONS);
        setBackgroundMode(true);
      } else {
        await attachForegroundSubscription();
        setBackgroundMode(false);
      }

      await startGeofence();

      setTracking(true);
      setPaused(false);
    } catch {
      setError('Unable to start live tracking. Please ensure GPS is enabled and try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Pause tracking ─────────────────────────────────────────────────────────

  async function pauseTracking() {
    try {
      await detachGps();
      setPaused(true);
      await sendNotification(
        'Tracking Paused',
        "Your location tracking has been paused. Open the app and tap \"Resume Tracking\" when you're ready to continue."
      );
    } catch {
      setError('Unable to pause tracking. Please try again.');
    }
  }

  // ── Resume tracking ────────────────────────────────────────────────────────

  async function resumeTracking() {
    setError(null);
    setLoading(true);

    try {
      if (backgroundMode) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, BG_TASK_OPTIONS);
      } else {
        await attachForegroundSubscription();
      }
      setPaused(false);
    } catch {
      setError('Unable to resume tracking. Please ensure GPS is enabled and try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Stop tracking ──────────────────────────────────────────────────────────

  async function stopTracking() {
    try {
      await detachGps();
      await stopGeofence();
    } finally {
      setTracking(false);
      setPaused(false);
      setBackgroundMode(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isBusy = loading;

  const geofenceBannerColors =
    geofenceStatus === 'inside'
      ? { bg: '#f0fdf4', border: '#86efac', text: '#15803d' }
      : geofenceStatus === 'outside'
      ? { bg: '#fff7ed', border: '#fdba74', text: '#c2410c' }
      : { bg: '#f8fafc', border: '#e2e8f0', text: '#64748b' };

  return (
    <View style={styles.container}>
      {/* ── Map ── */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={INITIAL_MAP_REGION}
        showsUserLocation
        showsMyLocationButton
      >
        {pathCoords.length >= 2 && (
          <Polyline
            coordinates={pathCoords}
            strokeColor="#3b82f6"
            strokeWidth={4}
          />
        )}

        <Circle
          center={GEOFENCE_CENTER}
          radius={GEOFENCE_RADIUS_M}
          fillColor="rgba(239, 68, 68, 0.12)"
          strokeColor="rgba(239, 68, 68, 0.7)"
          strokeWidth={2}
        />

        <Marker
          coordinate={GEOFENCE_CENTER}
          title={GEOFENCE_LABEL}
          description={`Geofence radius: ${GEOFENCE_RADIUS_M} m`}
          pinColor="red"
        />
      </MapView>

      {/* ── Geofence status banner ── */}
      {geofenceMessage && (
        <View
          style={[
            styles.geofenceBanner,
            { backgroundColor: geofenceBannerColors.bg, borderColor: geofenceBannerColors.border },
          ]}
        >
          <Text style={[styles.geofenceBannerText, { color: geofenceBannerColors.text }]}>
            {geofenceStatus === 'inside' ? '✓ Inside' : '✕ Outside'} — {geofenceMessage}
          </Text>
        </View>
      )}

      {/* ── Controls ── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>BuildMyTracks</Text>

        {!tracking && (
          <View style={styles.goalCard}>
            <Text style={styles.goalLabel}>Distance Goal (km)</Text>
            <TextInput
              style={styles.goalInput}
              value={goalKmInput}
              onChangeText={setGoalKmInput}
              keyboardType="decimal-pad"
              placeholder="e.g. 1.0"
              placeholderTextColor="#a0aec0"
            />
            <Text style={styles.goalHint}>
              You'll get a notification when you reach this distance.
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.button, (isBusy || tracking) && styles.buttonDisabled]}
          onPress={getLocation}
          disabled={isBusy || tracking}
        >
          {loading && !tracking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Get Current Location</Text>
          )}
        </TouchableOpacity>

        {!tracking ? (
          <TouchableOpacity
            style={[styles.button, styles.buttonTrack, isBusy && styles.buttonDisabled]}
            onPress={startTracking}
            disabled={isBusy}
          >
            {isBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Start Live Tracking</Text>
            )}
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[
                styles.button,
                paused ? styles.buttonTrack : styles.buttonPause,
                isBusy && styles.buttonDisabled,
              ]}
              onPress={paused ? resumeTracking : pauseTracking}
              disabled={isBusy}
            >
              {isBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>
                  {paused ? 'Resume Tracking' : 'Pause Tracking'}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.buttonStop, isBusy && styles.buttonDisabled]}
              onPress={stopTracking}
              disabled={isBusy}
            >
              <Text style={styles.buttonText}>Stop Live Tracking</Text>
            </TouchableOpacity>
          </>
        )}

        {tracking && (
          <View style={[styles.trackingBadge, paused && styles.trackingBadgePaused]}>
            <View style={[styles.trackingDot, paused && styles.trackingDotPaused]} />
            <Text style={[styles.trackingText, paused && styles.trackingTextPaused]}>
              {paused
                ? 'Tracking Paused'
                : backgroundMode
                ? 'Background Tracking Active'
                : 'Live Tracking Active'}
            </Text>
          </View>
        )}

        {latitude !== null && longitude !== null && (
          <View style={styles.coordsCard}>
            <Text style={styles.coordsLabel}>Latitude</Text>
            <Text style={styles.coordsValue}>{latitude.toFixed(6)}</Text>
            <Text style={styles.coordsLabel}>Longitude</Text>
            <Text style={styles.coordsValue}>{longitude.toFixed(6)}</Text>
            {logLength > 0 && (
              <>
                <Text style={styles.logCount}>
                  {logLength} point{logLength !== 1 ? 's' : ''} logged
                </Text>
                <Text style={styles.distanceText}>
                  Distance: {(totalDistanceKm * 1000).toFixed(0)} m
                  {totalDistanceKm >= 1 ? ` (${totalDistanceKm.toFixed(2)} km)` : ''}
                </Text>
                {tracking && (
                  <Text style={styles.goalProgressText}>
                    Goal: {Math.min(100, (totalDistanceKm / goalKm) * 100).toFixed(0)}% of{' '}
                    {goalKm.toFixed(2)} km
                    {goalReachedRef.current ? ' ✓' : ''}
                  </Text>
                )}
              </>
            )}
          </View>
        )}

        {error !== null && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {/* ── Privacy notice ── */}
      <View style={styles.privacyCard}>
        <Text style={styles.privacyTitle}>Data & Privacy</Text>

        <View style={styles.privacyRow}>
          <Text style={styles.privacyLabel}>Collected</Text>
          <Text style={styles.privacyValue}>
            GPS coordinates (latitude, longitude) and timestamps
          </Text>
        </View>

        <View style={styles.privacyDivider} />

        <View style={styles.privacyRow}>
          <Text style={styles.privacyLabel}>When</Text>
          <Text style={styles.privacyValue}>
            Only while tracking is active — pausing stops all collection immediately
          </Text>
        </View>

        <View style={styles.privacyDivider} />

        <View style={styles.privacyRow}>
          <Text style={styles.privacyLabel}>Stored</Text>
          <Text style={styles.privacyValue}>
            On this device only — never uploaded, shared, or transmitted
          </Text>
        </View>

        <View style={styles.privacyDivider} />

        <View style={styles.privacyRow}>
          <Text style={styles.privacyLabel}>Control</Text>
          <Text style={styles.privacyValue}>
            Tap <Text style={styles.privacyInlineLabel}>Pause Tracking</Text> to temporarily
            stop collection, or{' '}
            <Text style={styles.privacyInlineLabel}>Stop Live Tracking</Text> to end the
            session
          </Text>
        </View>
      </View>

      <StatusBar style="auto" />
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f4f8',
  },
  map: {
    width: '100%',
    height: MAP_HEIGHT,
  },
  geofenceBanner: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  geofenceBannerText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 16,
    letterSpacing: 0.5,
  },
  goalCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  goalLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  goalInput: {
    borderWidth: 1,
    borderColor: '#cbd5e0',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 16,
    color: '#2d3748',
    backgroundColor: '#f7fafc',
  },
  goalHint: {
    marginTop: 6,
    fontSize: 11,
    color: '#a0aec0',
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    minWidth: 220,
    alignItems: 'center',
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  buttonDisabled: {
    opacity: 0.5,
    shadowOpacity: 0,
    elevation: 0,
  },
  buttonTrack: {
    backgroundColor: '#22c55e',
    shadowColor: '#22c55e',
  },
  buttonPause: {
    backgroundColor: '#f59e0b',
    shadowColor: '#f59e0b',
  },
  buttonStop: {
    backgroundColor: '#ef4444',
    shadowColor: '#ef4444',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  trackingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f0fdf4',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  trackingBadgePaused: {
    backgroundColor: '#fffbeb',
    borderColor: '#fcd34d',
  },
  trackingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
  },
  trackingDotPaused: {
    backgroundColor: '#f59e0b',
  },
  trackingText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#16a34a',
  },
  trackingTextPaused: {
    color: '#b45309',
  },
  coordsCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  coordsLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#718096',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 8,
  },
  coordsValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#2d3748',
    marginTop: 4,
  },
  logCount: {
    marginTop: 12,
    fontSize: 12,
    color: '#a0aec0',
    fontWeight: '500',
  },
  distanceText: {
    marginTop: 4,
    fontSize: 14,
    color: '#4a5568',
    fontWeight: '600',
  },
  goalProgressText: {
    marginTop: 4,
    fontSize: 12,
    color: '#3b82f6',
    fontWeight: '500',
  },
  errorCard: {
    backgroundColor: '#fff5f5',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    borderWidth: 1,
    borderColor: '#feb2b2',
  },
  errorText: {
    color: '#c53030',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  privacyCard: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    padding: 16,
    paddingBottom: 24,
    width: '100%',
    gap: 8,
  },
  privacyTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#a0aec0',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  privacyRow: {
    flexDirection: 'row',
    gap: 8,
  },
  privacyDivider: {
    height: 1,
    backgroundColor: '#f1f5f9',
  },
  privacyLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4a5568',
    width: 56,
    paddingTop: 1,
  },
  privacyValue: {
    flex: 1,
    fontSize: 12,
    color: '#718096',
    lineHeight: 18,
  },
  privacyInlineLabel: {
    fontWeight: '700',
    color: '#4a5568',
  },
});

registerRootComponent(App);
