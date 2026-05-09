# BuildMyTracks

A React Native mobile app built with Expo that tracks a user's GPS location in real time — displaying movement on a live map, drawing the traveled path, and firing alerts when crossing a geofenced area.

## About

Built for **SOFT 211 - Mobile Application Development** at Bates Technical College.

## Features

- **Map View** — full interactive map centered on Bates Technical College with pan and zoom
- **Live Path Drawing** — a polyline traces the user's exact route on the map as they move
- **Geofence** — a 200 m radius boundary around Bates Technical College is drawn on the map; the app detects entry and exit events
- **Geofence Alerts** — crossing the geofence boundary triggers an in-app Alert dialog, a status banner below the map, and a push notification
- **Get Current Location** — retrieves a single high-accuracy GPS fix and pans the map to the user's position
- **Live Tracking** — continuously updates coordinates and path in real time
- **Background Tracking** — continues logging GPS when the app is minimized or the screen is locked
- **Pause & Resume** — suspends location updates without clearing the session log
- **Distance Goal** — sends a notification when the user reaches a configurable distance target
- **Privacy Notice** — persistent on-screen panel explaining what data is collected and how to stop it

## Tech Stack

| Package | Purpose |
|---|---|
| [Expo](https://expo.dev) ~54 | Managed React Native framework |
| [react-native-maps](https://github.com/react-native-maps/react-native-maps) 1.20 | Map view, Polyline, Circle, Marker |
| [expo-location](https://docs.expo.dev/versions/latest/sdk/location/) ~19 | Foreground/background GPS + geofencing |
| [expo-task-manager](https://docs.expo.dev/versions/latest/sdk/task-manager/) ~14 | Background task execution |
| [expo-notifications](https://docs.expo.dev/versions/latest/sdk/notifications/) ~0.32 | Push notifications for geofence and goal events |
| React Native 0.81 | Core mobile UI framework |
| TypeScript | Static typing |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- A physical device or emulator with GPS support
- [Expo Go](https://expo.dev/client) installed on your device

### Installation

```bash
git clone https://github.com/blburks/LocationTracking.git
cd LocationTracking
npm install
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS).

## How It Works

### Map & Path

The map opens centered on the geofence location (Bates Technical College). When Live Tracking is started, each GPS update appends a coordinate to the path array, and the `<Polyline>` component re-renders the route in real time. The map camera follows the user automatically.

### Geofence

When tracking starts, `expo-location.startGeofencingAsync` registers a 200 m circular region around Bates Technical College. The system monitors the device's position against this boundary using a background `TaskManager` task. When the boundary is crossed:

1. The task emits a `DeviceEventEmitter` event to the foreground component
2. An `Alert` dialog appears
3. A color-coded status banner updates below the map (green = inside, orange = outside)
4. A push notification is sent

### Location Simulator Testing

To test geofencing without physical movement, use the Expo Go location simulator (iOS) or a mock location app (Android). Simulate movement in and out of the Bates Technical College coordinates to trigger geofence events.

**Geofence center:** `47.2311, -122.4446` (Bates Technical College, Tacoma, WA)
**Geofence radius:** 200 meters

## Permissions

| Permission | When | Why |
|---|---|---|
| Location (foreground) | On first tracking action | Required to read GPS coordinates |
| Location (background) | When starting live tracking | Required to continue tracking when app is in background |
| Notifications | On app launch | Required to send geofence and goal alerts |

On Android, background location requires `ACCESS_BACKGROUND_LOCATION` and a foreground service notification — both configured in `app.json`.

On iOS, `NSLocationAlwaysAndWhenInUseUsageDescription` and `UIBackgroundModes: ["location"]` are set in `app.json`.

## Project Structure

```
LocationTracking/
├── index.tsx        # All app logic: map, tracking, geofence, UI
├── app.json         # Expo config — permissions, background modes, app metadata
├── package.json     # Dependencies
└── assets/          # App icons and splash screen
```

## Privacy

All recorded coordinates are stored in memory on the device only for the duration of the session. No location data is uploaded, shared, or transmitted to any external server.
