import { registerRootComponent } from 'expo';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

const LOCATION_TASK = 'background-location-task';
const LOCATION_UPDATE_EVENT = 'bmt_location_update';

// ─── Types ────────────────────────────────────────────────────────────────────

type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

// ─── Module-level track log ───────────────────────────────────────────────────

/**
 * Shared between the background task callback and the UI.
 * In Expo's managed workflow both run in the same JS context.
 * Never cleared on pause/resume — only on a fresh Start.
 */
const trackLog: Coordinate[] = [];

// ─── Background task ──────────────────────────────────────────────────────────

/**
 * Defined at module scope (required by expo-task-manager).
 * Emits LOCATION_UPDATE_EVENT so the UI listener receives updates whether the
 * app is in the foreground or just returned from the background.
 */
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

// ─── Shared GPS options ───────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

function App() {
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);
  const [logLength, setLogLength] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const subscriberRef = useRef<Location.LocationSubscription | null>(null);

  // ── Effects ────────────────────────────────────────────────────────────────

  /**
   * Unified coordinate listener.
   * Both the background TaskManager callback and the foreground watchPositionAsync
   * callback emit LOCATION_UPDATE_EVENT, so this single handler drives all UI
   * updates regardless of which tracking path is active.
   *
   * State transition coverage:
   *   • Foreground tracking active   → fires on every new fix
   *   • Background task active       → fires when OS delivers a fix (both while
   *                                    backgrounded and after returning to fg)
   *   • Paused                       → never fires (GPS detached)
   *   • Stopped                      → never fires (GPS detached + event removed)
   */
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      LOCATION_UPDATE_EVENT,
      (coord: Coordinate) => {
        setLatitude(coord.latitude);
        setLongitude(coord.longitude);
        setLogLength(trackLog.length);
      }
    );
    return () => sub.remove();
  }, []);

  /**
   * Restore tracking state if the background task survived an app restart.
   * iOS can keep a background location task alive even after the app is killed.
   * On relaunch the JS state would be reset to idle, so we check the OS and
   * reconcile.
   */
  useEffect(() => {
    async function restoreTrackingState() {
      try {
        const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
        if (isRunning) {
          setTracking(true);
          setBackgroundMode(true);
          // trackLog will repopulate as the next background fix arrives and
          // DeviceEventEmitter fires. If there are already entries (same JS
          // context restart), sync the display immediately.
          if (trackLog.length > 0) {
            const latest = trackLog[trackLog.length - 1];
            setLatitude(latest.latitude);
            setLongitude(latest.longitude);
            setLogLength(trackLog.length);
          }
        }
      } catch {
        // hasStartedLocationUpdatesAsync throws if task manager isn't ready;
        // safe to ignore — app just starts in idle state.
      }
    }
    restoreTrackingState();
  }, []);

  /**
   * Safety-net sync when the app returns to the foreground.
   * Covers the gap between the last background fix and when the UI renders,
   * ensuring the most recent logged coordinate is always shown immediately on
   * foreground return.
   *
   * State transition coverage:
   *   • BG → FG (active tracking)  → shows latest coord from trackLog
   *   • BG → FG (paused)           → shows last coord before pause (no change)
   *   • BG → FG (stopped)          → trackLog.length === 0, no-op
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && trackLog.length > 0) {
        const latest = trackLog[trackLog.length - 1];
        setLatitude(latest.latitude);
        setLongitude(latest.longitude);
        setLogLength(trackLog.length);
      }
    });
    return () => sub.remove();
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Starts a foreground watchPositionAsync subscription.
   * Emits LOCATION_UPDATE_EVENT on every fix so the unified listener updates
   * the UI — same path as the background task.
   * Shared between startTracking (foreground-only) and resumeTracking.
   */
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

  /** Tears down GPS updates without ending the session. */
  async function detachGps() {
    if (backgroundMode) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    } else {
      subscriberRef.current?.remove();
      subscriberRef.current = null;
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

      // Start a new session — clear any previous log
      trackLog.length = 0;
      setLogLength(0);

      if (isBackground) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, BG_TASK_OPTIONS);
        setBackgroundMode(true);
      } else {
        await attachForegroundSubscription();
        setBackgroundMode(false);
      }

      setTracking(true);
      setPaused(false);
    } catch {
      setError('Unable to start live tracking. Please ensure GPS is enabled and try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Pause tracking ─────────────────────────────────────────────────────────

  /**
   * Stops GPS updates and enters paused state.
   * trackLog is NOT cleared — session data is fully preserved.
   * The paused flag survives background/foreground cycles since it is React
   * component state (the JS context is not killed on minimize).
   */
  async function pauseTracking() {
    try {
      await detachGps();
      setPaused(true);
    } catch {
      setError('Unable to pause tracking. Please try again.');
    }
  }

  // ── Resume tracking ────────────────────────────────────────────────────────

  /**
   * Restarts GPS updates from paused state.
   * trackLog continues from where it left off — no data loss.
   */
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

  /**
   * Fully ends the tracking session.
   * GPS is detached, all tracking state is reset.
   * Coordinates remain visible on screen but will not update.
   */
  async function stopTracking() {
    try {
      await detachGps();
    } finally {
      setTracking(false);
      setPaused(false);
      setBackgroundMode(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isBusy = loading;

  return (
    <View style={styles.container}>
      {/* ── Scrollable main content ── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>BuildMyTracks</Text>

        {/* Get Current Location — disabled while a session is running */}
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

        {/* Start / Pause / Resume — mutually exclusive with the stop button */}
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

        {/* Status badge */}
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

        {/* Coordinates card */}
        {latitude !== null && longitude !== null && (
          <View style={styles.coordsCard}>
            <Text style={styles.coordsLabel}>Latitude</Text>
            <Text style={styles.coordsValue}>{latitude.toFixed(6)}</Text>
            <Text style={styles.coordsLabel}>Longitude</Text>
            <Text style={styles.coordsValue}>{longitude.toFixed(6)}</Text>
            {logLength > 0 && (
              <Text style={styles.logCount}>
                {logLength} point{logLength !== 1 ? 's' : ''} logged
              </Text>
            )}
          </View>
        )}

        {error !== null && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {/* ── Privacy & data notice — always visible at the bottom ── */}
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f4f8',
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
